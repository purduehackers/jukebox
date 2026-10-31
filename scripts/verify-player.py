#!/usr/bin/env python3
"""Phase-3 Firefox integration evidence for the designated jukebox player.

Starts an isolated real Python audio worker, a short-policy service fixture, and
Vite on loopback-only ephemeral ports. Every Selenium Firefox instance receives
a fresh profile; autoplay preferences are deliberately untouched. No production
credentials, source traffic, or fixed service ports are used.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parent.parent


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def http_json(url, body=None, headers=None, timeout=8):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json', **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read()
        return json.loads(raw) if raw else {}


def command(base, kind, payload=None, token=None):
    headers = {'Authorization': f'Bearer {token}'} if token else {}
    return http_json(base + '/api/v1/commands', {
        'commandId': str(uuid.uuid4()), 'type': kind, 'payload': payload or {},
    }, headers)


def wait_until(fn, timeout=20, interval=.1, message='condition timed out'):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as exc:
            last = exc
        time.sleep(interval)
    raise AssertionError(f'{message}: {last!r}')


def start(cmd, cwd, env=None, log=None):
    return subprocess.Popen(cmd, cwd=cwd, env=env, stdout=log or subprocess.DEVNULL,
                            stderr=subprocess.STDOUT, text=True, start_new_session=True)


def make_driver(headless=True):
    options = Options()
    if headless:
        options.add_argument('-headless')
    binary = shutil.which('firefox')
    if binary:
        options.binary_location = binary
    # Selenium creates a new temporary Firefox profile. Do not set autoplay prefs.
    driver = webdriver.Firefox(options=options)
    driver.set_window_size(1440, 1000)
    driver.set_script_timeout(12)
    return driver


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', default='.local/player-firefox-evidence.json')
    p.add_argument('--headed', action='store_true')
    p.add_argument('--base-url', help='Use an already-running app (script still requires its API fixture tracks)')
    args = p.parse_args()
    temp = None
    processes = []
    drivers = []
    report = {'atUTC': datetime.now(timezone.utc).isoformat(), 'checks': {}, 'measurements': {},
              'hardware': 'No HDMI/wall listening claim; this script records browser media state only',
              'autoplayPreferencesOverridden': False}
    try:
        if args.base_url:
            app = args.base_url.rstrip('/')
            base = app
            worker_data = None
            report['fixtureMode'] = 'external app; caller owns service and worker'
            fixture_service = None
            fixture_service_args = None
        else:
            temp = tempfile.TemporaryDirectory(prefix='jukebox-player-', dir=ROOT / '.local' if (ROOT / '.local').exists() else None)
            work = Path(temp.name)
            worker_data = work / 'worker'
            service_data = work / 'service'
            worker_port, service_port, app_port = free_port(), free_port(), free_port()
            worker_log = open(work / 'worker.log', 'w')
            worker = start([sys.executable, '-m', 'jukebox.server', '--port', str(worker_port), '--data', str(worker_data), '--job-seconds', '0.2'], ROOT, log=worker_log)
            processes.append(worker)
            worker_url = f'http://127.0.0.1:{worker_port}'
            wait_until(lambda: http_json(worker_url + '/api/status'), timeout=30, message='worker startup')
            origin = f'http://127.0.0.1:{app_port}'
            service_log = open(work / 'service.log', 'w')
            fixture_service_args = ['node', 'src/server/player-fixture-server.ts', '--port', str(service_port), '--worker', worker_url,
                                    '--data', str(service_data), '--origin', origin, '--periodMs', '12000', '--leaseMs', '6000']
            service = start(fixture_service_args, ROOT, log=service_log)
            fixture_service = service
            fixture_service_log = service_log
            processes.append(service)
            service_url = f'http://127.0.0.1:{service_port}'
            wait_until(lambda: http_json(service_url + '/healthz'), timeout=30, message='fixture service startup')
            env = os.environ.copy()
            env['JUKEBOX_SERVICE'] = service_url
            vite_log = open(work / 'vite.log', 'w')
            vite = start([str(ROOT / 'node_modules/.bin/vite'), '--host', '127.0.0.1', '--port', str(app_port), '--strictPort'], ROOT, env=env, log=vite_log)
            processes.append(vite)
            app = origin
            wait_until(lambda: urllib.request.urlopen(app + '/display', timeout=3).status == 200, timeout=30, message='Vite startup')
            base = app
            report['fixtureMode'] = 'isolated Python worker + short-policy service + Vite'
            report['ports'] = {'worker': worker_port, 'service': service_port, 'app': app_port}

        # Device pairing and queue setup happen through the real admin API. The
        # admin browser below independently proves the public admin page is silent.
        admin = make_driver(not args.headed)
        drivers.append(admin)
        admin.get(base + '/auth/login?returnTo=%2Fadmin')
        wait_until(lambda: admin.find_elements(By.NAME, 'sub'), timeout=10, message='fake auth form')
        admin.find_element(By.NAME, 'sub').send_keys('phase3_admin')
        roles = admin.find_elements(By.NAME, 'roles')
        if roles:
            roles[0].click()
        admin.find_element(By.CSS_SELECTOR, 'button[type=submit],button').click()
        WebDriverWait(admin, 15).until(lambda d: '/admin' in d.current_url)
        report['browser'] = {'browserName': admin.capabilities.get('browserName'), 'browserVersion': admin.capabilities.get('browserVersion'),
                             'geckodriverVersion': admin.capabilities.get('moz:geckodriverVersion'), 'headless': not args.headed}
        assert report['browser']['browserName'] == 'firefox'
        cookies = admin.get_cookies()
        cookie = '; '.join(f"{c['name']}={c['value']}" for c in cookies)
        admin_headers = {'Cookie': cookie, 'Origin': base}

        # Cookie-authenticated command helper uses the session cookie directly.
        def user_command(kind, payload=None):
            env = {'Cookie': cookie, 'Origin': base}
            return http_json(base + '/api/v1/commands', {'commandId': str(uuid.uuid4()), 'type': kind, 'payload': payload or {}}, env)

        paired = user_command('device.pairing.create', {'name': 'phase3 Firefox fixture'})
        assert paired['ok'], paired
        pairing_code = paired['result']['code']
        for track in ('fixture:master', 'fixture:song'):
            result = user_command('master.add', {'url': track})
            assert result['ok'], result
        opened = user_command('night.open')
        assert opened['ok'], opened
        request = user_command('request.submit', {'url': 'fixture:request'})
        # In this build request submit requires an attendee. Start a separate
        # attendee session in a fresh profile rather than weakening server auth.
        if not request.get('ok'):
            attendee = make_driver(not args.headed)
            drivers.append(attendee)
            attendee.get(base + '/auth/login?returnTo=%2Fqueue')
            wait_until(lambda: attendee.find_elements(By.NAME, 'sub'), timeout=10, message='attendee fake auth form')
            attendee.find_element(By.NAME, 'sub').send_keys('phase3_attendee')
            attendee.find_element(By.CSS_SELECTOR, 'button[type=submit],button').click()
            WebDriverWait(attendee, 15).until(lambda d: '/queue' in d.current_url)
            acookie = '; '.join(f"{c['name']}={c['value']}" for c in attendee.get_cookies())
            def attendee_command(url):
                return http_json(base + '/api/v1/commands', {'commandId': str(uuid.uuid4()), 'type': 'request.submit', 'payload': {'url': url}}, {'Cookie': acookie, 'Origin': base})
            request = attendee_command('fixture:request')
            assert request['ok'], request
            second_request = attendee_command('fixture:aac')
            assert second_request['ok'], second_request
            report['checks']['attendeeSessionSeparate'] = True

        wait_until(lambda: all(x['status'] == 'ready' for x in http_json(base + '/api/v1/snapshot', headers=admin_headers).get('requests', []))
                    and all(x['status'] == 'ready' for x in http_json(base + '/api/v1/snapshot', headers=admin_headers).get('master', [])),
                    timeout=90, message='fixture media preparation')
        play = user_command('playback.play')
        assert play['ok'], play

        player = make_driver(not args.headed)
        drivers.append(player)
        player.get(base + '/display')
        wait = WebDriverWait(player, 30, poll_frequency=.1)
        wait.until(lambda d: d.find_elements(By.ID, 'player-code'))
        player.find_element(By.ID, 'player-code').send_keys(pairing_code)
        player.find_element(By.ID, 'player-pair').click()
        wait.until(lambda d: bool(d.execute_script("return localStorage.getItem('jukebox.device.v1')")))
        pair = json.loads(player.execute_script("return localStorage.getItem('jukebox.device.v1')"))
        assert pair.get('deviceId') and pair.get('token')
        player.find_element(By.ID, 'player-claim').click()
        wait.until(lambda d: d.find_elements(By.ID, 'player-activate'))
        player.find_element(By.ID, 'player-activate').click()
        wait.until(lambda d: d.find_element(By.ID, 'jukebox-audio').get_attribute('src'))

        def status():
            return player.find_element(By.CSS_SELECTOR, '[data-testid="player"]').get_attribute('data-status')

        def frame():
            el = player.find_element(By.CSS_SELECTOR, '[data-testid="player"]')
            return {key: el.get_attribute('data-' + key) for key in ('status', 'generation', 'load-id', 'epoch')}

        wait.until(lambda d: status() == 'playing')
        audio = lambda: player.execute_script("const a=document.getElementById('jukebox-audio');return {paused:a.paused,time:a.currentTime,duration:a.duration,ready:a.readyState,error:a.error?.code||null,src:a.currentSrc}")
        wait.until(lambda d: audio()['ready'] >= 2)
        report['checks']['pairedClaimedAndActivated'] = True
        report['playerFrame'] = frame()
        report['checks']['audioElementIsNativeAudio'] = player.execute_script("return !!document.getElementById('jukebox-audio') && !document.querySelector('video')")

        # Admin/queue profiles remain silent while the display produces audio.
        for driver in drivers[:-1]:
            driver.get(base + ('/queue' if driver is not admin else '/admin'))
            quiet = driver.execute_script("return [...document.querySelectorAll('audio,video')].every(x=>x.paused || x.muted || x.volume===0)")
            assert quiet
        report['checks']['adminAndAttendeeProfilesSilent'] = True

        # Measure remote command to player acknowledgement at the desired epoch.
        snap = http_json(base + '/api/v1/snapshot')
        target_entry = snap['nowPlaying']['entryId']
        started = time.monotonic()
        seek_result = user_command('playback.seek', {'entryId': target_entry, 'positionSec': 3.0})
        assert seek_result['ok'], seek_result
        wait.until(lambda d: int(frame()['epoch'] or 0) >= (snap['playback']['desiredEpoch'] or 0) + 1)
        report['measurements']['commandAckLatencyMs'] = round((time.monotonic() - started) * 1000, 1)

        # Request interrupt/resume and compare actual checkpoint to paused audio.
        # A mix is interruptible as soon as the short fixture period elapses.
        wait.until(lambda d: http_json(base + '/api/v1/snapshot').get('nowPlaying', {}).get('kind') == 'request', timeout=30, message='scheduled request interrupt')
        interrupted = audio()
        state = http_json(base + '/api/v1/snapshot')
        checkpoint = state.get('suspendedMaster', {}).get('positionSec')
        assert checkpoint is not None
        wait.until(lambda d: http_json(base + '/api/v1/snapshot').get('nowPlaying', {}).get('kind') == 'master', timeout=20, message='request ended and master resumed')
        resumed = audio()['time']
        report['measurements']['resumeCheckpointSec'] = checkpoint
        report['measurements']['resumeObservedSec'] = resumed
        report['measurements']['resumeErrorSec'] = round(resumed - checkpoint, 3)
        report['checks']['mixInterruptedAndResumed'] = abs(resumed - checkpoint) < 1.5
        assert report['checks']['mixInterruptedAndResumed']

        # Move from the resumed mix to the exact 360 s master fixture. The
        # second distinct request remains ready for the following turn.
        snap = http_json(base + '/api/v1/snapshot')
        current = snap.get('nowPlaying') or {}
        if current.get('kind') == 'master':
            skipped = user_command('playback.skip', {'entryId': current['entryId']})
            assert skipped['ok'], skipped
            wait.until(lambda d: (http_json(base + '/api/v1/snapshot').get('nowPlaying') or {}).get('title') == 'fixture:song', timeout=15, message='advance to normal song')
            time.sleep(12.5)  # make the next request due while the normal song plays
            assert http_json(base + '/api/v1/snapshot')['nowPlaying']['kind'] == 'master'
            report['checks']['normalSongNotInterruptedWhenDue'] = True
            snap = http_json(base + '/api/v1/snapshot')
            seek = user_command('playback.seek', {'entryId': snap['nowPlaying']['entryId'], 'positionSec': 358.5})
            assert seek['ok'], seek
            wait.until(lambda d: audio()['time'] >= 358)
            wait.until(lambda d: http_json(base + '/api/v1/snapshot')['nowPlaying']['kind'] == 'request', timeout=8, message='request begins after normal song ended')
            report['checks']['normalSongWaitedForEnded'] = True

            if worker_data:
                # Remove only the second request's cached bytes so the player
                # exercises the real media-origin failure, retry, and refund.
                worker_status = http_json(worker_url + '/api/status')
                job = next(j for j in worker_status['jobs'] if j['source'] == 'fixture:aac' and j['status'] == 'ready')
                asset = next(a for a in worker_status['assets'] if a['id'] == job['id'])
                broken = worker_data / 'assets' / asset['id'] / asset['file']
                held = broken.with_suffix(broken.suffix + '.fixture-held')
                broken.rename(held)
                try:
                    wait.until(lambda d: http_json(base + '/api/v1/snapshot')['nowPlaying']['kind'] == 'master', timeout=15, message='technical failure returns to master')
                    events = http_json(base + '/api/v1/events?after=0', headers=admin_headers).get('events', [])
                    report['failureEventTypes'] = [e['type'] for e in events if 'fail' in e['type'].lower() or 'refund' in e['type'].lower()]
                    report['checks']['missingRequestAssetRefunded'] = any('fail' in e.lower() or 'refund' in e.lower() for e in report['failureEventTypes'])
                finally:
                    held.rename(broken)
                assert report['checks']['missingRequestAssetRefunded'], report['failureEventTypes']

        # Competing tab uses the same paired identity but must explicitly take
        # over; it must not create simultaneous authorized audio by default.
        second = make_driver(not args.headed)
        drivers.append(second)
        second.get(base + '/display')
        wait2 = WebDriverWait(second, 15, poll_frequency=.1)
        wait2.until(lambda d: d.find_elements(By.ID, 'player-claim'))
        second_token = second.execute_script("return localStorage.getItem('jukebox.device.v1')")
        if not second_token:
            second.execute_script('localStorage.setItem(arguments[0], arguments[1])', 'jukebox.device.v1', json.dumps(pair))
            second.refresh()
        second.find_element(By.ID, 'player-claim').click()
        time.sleep(.5)
        report['checks']['secondTabDoesNotAutoTakeOver'] = second.execute_script("return document.querySelector('[data-testid=player]')?.dataset.status !== 'playing'")
        assert report['checks']['secondTabDoesNotAutoTakeOver']

        # Refresh recovery: local pairing persists; activation remains explicit.
        player.refresh()
        wait.until(lambda d: d.find_elements(By.ID, 'player-claim'))
        wait.until(lambda d: d.execute_script("return !!localStorage.getItem('jukebox.device.v1')"))
        status_after_refresh = status()
        report['checks']['refreshRetainsPairAndRequiresActivation'] = status_after_refresh != 'playing'
        # The prior document's lease is deliberately allowed to expire rather
        # than using an implicit takeover from the refreshed tab.
        time.sleep(6.5)
        player.find_element(By.ID, 'player-claim').click()
        wait.until(lambda d: d.find_elements(By.ID, 'player-activate'))
        player.find_element(By.ID, 'player-activate').click()
        wait.until(lambda d: status() == 'playing')
        report['checks']['refreshRecoveryReactivated'] = True

        if fixture_service:
            fixture_service.terminate()
            fixture_service.wait(timeout=8)
            wait.until(lambda d: audio()['paused'] and status() != 'playing', timeout=8, message='player silences on service outage')
            report['checks']['serviceOutageStopsLocalAudio'] = True
            fixture_service = start(fixture_service_args, ROOT, log=fixture_service_log)
            processes.append(fixture_service)
            wait_until(lambda: http_json(base + '/api/v1/snapshot'), timeout=20, message='service restart')
            time.sleep(6.5)
            reclaimed = command(base, 'player.claim', {}, pair['token'])
            assert reclaimed['ok'], reclaimed
            report['checks']['leaseExpiryAllowsReclaim'] = reclaimed['result']['generation'] > int(frame()['generation'] or 0)
            assert report['checks']['leaseExpiryAllowsReclaim']

        # Record a real worker-served media load and codec.
        report['media'] = player.execute_script("const a=document.getElementById('jukebox-audio');return {mime:a.currentSrc?document.querySelector('source')?.type||null:null,networkEntries:performance.getEntriesByType('resource').filter(x=>x.name.includes('/media/')).map(x=>({name:x.name,durationMs:x.duration,transferSize:x.transferSize}))}")
        report['result'] = 'passed'
    except Exception as exc:
        report['result'] = 'failed'
        report['error'] = repr(exc)
        for index, driver in enumerate(drivers):
            try:
                report.setdefault('failureBrowsers', []).append({'index': index, 'url': driver.current_url,
                    'player': driver.execute_script("const p=document.querySelector('[data-testid=player]');return p?{...p.dataset}:null"),
                    'audio': driver.execute_script("const a=document.getElementById('jukebox-audio');return a?{paused:a.paused,time:a.currentTime,error:a.error?.code||null}:null")})
            except Exception:
                pass
        raise
    finally:
        report['finishedUTC'] = datetime.now(timezone.utc).isoformat()
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + '\n')
        for driver in reversed(drivers):
            try:
                driver.quit()
            except Exception:
                pass
        for proc in reversed(processes):
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
        if temp:
            temp.cleanup()
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
