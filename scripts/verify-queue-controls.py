#!/usr/bin/env python3
"""Real Firefox + worker evidence for queue playback controls (mode, Play now, request interval).

Production lease/heartbeat/interval policies; real Python worker with fixture audio; the display runs
in real headless Firefox on a dedicated null audio sink. Measures the suspended master's checkpoint
against the audio element's actual paused time, including while Requests only is silent.
Admin/attendee commands use fetch in separate Firefox profiles. No audible HDMI claim.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

ROOT = Path(__file__).resolve().parent.parent


def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def http(url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=3) as res:
        return json.load(res)


def until(fn, seconds=20):
    end = time.monotonic() + seconds
    last = None
    while time.monotonic() < end:
        try:
            last = fn()
            if last:
                return last
        except Exception as error:
            last = error
        time.sleep(.05)
    raise AssertionError(f'Timed out: {last!r}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='.local/queue-controls-firefox-evidence.json')
    args = parser.parse_args()
    report = {'atUTC': datetime.now(timezone.utc).isoformat(), 'checks': {}, 'measurements': [],
              'hardware': 'Headless development Linux; HDMI, wall and audible checks pending',
              'autoplayPreferencesOverridden': False, 'leaseMs': 15000, 'heartbeatMs': 5000}
    # Headless Firefox still uses the host sound server. Route only these owned
    # browser processes to a dedicated null sink; never change the user's default.
    sink_name = f'jukebox_verify_{os.getpid()}'
    sink_module = subprocess.check_output([
        'pactl', 'load-module', 'module-null-sink', f'sink_name={sink_name}',
        'sink_properties=device.description=JukeboxVerification',
    ], text=True).strip()
    browser_env = {**os.environ, 'PULSE_SINK': sink_name}
    report['audioOutput'] = {'routing': 'dedicated PulseAudio null sink', 'sink': sink_name,
                             'systemDefaultChanged': False}
    drivers, children, logs = [], [], []
    temp = tempfile.TemporaryDirectory(prefix='jukebox-player-')
    work = Path(temp.name)
    wp, sp, ap = port(), port(), port()
    worker_url, service_url, app = f'http://127.0.0.1:{wp}', f'http://127.0.0.1:{sp}', f'http://127.0.0.1:{ap}'

    def start(argv, env=None):
        log = open(work / f'{len(logs)}.log', 'w+')
        logs.append(log)
        proc = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        children.append(proc)
        return proc

    def browser(path):
        options = Options()
        options.add_argument('-headless')
        options.binary_location = '/usr/bin/firefox'
        d = webdriver.Firefox(options=options, service=Service(env=browser_env))
        drivers.append(d)
        d.set_window_size(1440, 1000)
        d.set_script_timeout(10)
        d.get(app + path)
        return d

    def click(d, id):
        until(lambda: d.find_elements(By.ID, id) and d.find_element(By.ID, id).is_enabled())
        d.find_element(By.ID, id).click()

    def login(d, sub, organizer=False):
        d.get(app + '/auth/login?returnTo=' + ('/admin' if organizer else '/queue'))
        until(lambda: d.find_elements(By.NAME, 'sub'))
        d.find_element(By.NAME, 'sub').send_keys(sub)
        if organizer:
            d.find_element(By.NAME, 'roles').click()
        d.find_element(By.TAG_NAME, 'button').click()
        until(lambda: '/admin' in d.current_url if organizer else '/queue' in d.current_url)

    def cmd(d, kind, payload=None):
        result = d.execute_async_script('''
          const done=arguments[arguments.length-1];
          fetch('/api/v1/commands',{method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({commandId:arguments[0],type:arguments[1],payload:arguments[2]})})
            .then(r=>r.json()).then(done,e=>done({error:String(e)}));
        ''', str(uuid.uuid4()), kind, payload or {})
        assert result.get('ok'), (kind, result)
        return result['result']

    def snap(d=None):
        if d:
            return d.execute_async_script("fetch('/api/v1/snapshot').then(r=>r.json()).then(arguments[0])")
        return http(app + '/api/v1/snapshot')

    def audio(d):
        return d.execute_script("const a=document.getElementById('jukebox-audio'),p=document.querySelector('[data-testid=player]');return {paused:a.paused,time:a.currentTime,duration:a.duration,src:a.currentSrc,ready:a.readyState,...p.dataset}")

    def playing(d, kind=None):
        return until(lambda: not audio(d)['paused'] and audio(d)['status'] == 'playing' and (not kind or snap()['nowPlaying']['kind'] == kind))

    def due():
        http(service_url + '/__test/due', {})

    def titles():
        s = snap()
        return (s['nowPlaying'] or {}).get('title'), (s['nowPlaying'] or {}).get('kind')

    def last_seek(min_time):
        samples = player.execute_script('return window.playerSamples')
        return [x for x in samples if x['name'] == 'seeked' and x['time'] > min_time][-1]['time']

    try:
        worker = start([sys.executable, '-m', 'jukebox.server', '--port', str(wp), '--data', str(work/'worker')])
        until(lambda: http(worker_url + '/api/status'), 30)
        service_args = ['node', 'scripts/player-fixture-server.ts', '--port', str(sp), '--worker', worker_url,
                        '--data', str(work/'service'), '--origin', app]
        env = {**os.environ, 'JUKEBOX_SERVICE': service_url}
        service = start(service_args)
        start([str(ROOT/'node_modules/.bin/vite'), '--port', str(ap), '--strictPort'], env)
        report['runtime'] = 'isolated test service; production lease, heartbeat and 15 minute policies; real worker'
        until(lambda: http(service_url + '/healthz'), 30)
        until(lambda: urllib.request.urlopen(app+'/display', timeout=2).status == 200, 30)
        admin = browser('/admin')
        login(admin, 'qc_admin', True)
        attendee = browser('/queue')
        login(attendee, 'qc_attendee')
        cmd(admin, 'night.open')
        master = cmd(admin, 'master.add', {'url': 'fixture:master'})['entryId']
        until(lambda: all(x['status'] == 'ready' for x in snap(admin)['master']), 90)
        player = browser('/display')
        report['browser'] = {k: player.capabilities.get(k) for k in ['browserName', 'browserVersion', 'platformName', 'moz:headless']}
        assert report['browser']['browserName'] == 'firefox'
        until(lambda: audio(player)['generation'])
        until(lambda: player.find_elements(By.ID, 'player-activate'))
        click(player, 'player-activate')
        playing(player, 'master')
        player.execute_script("""window.playerSamples=[];const a=document.getElementById('jukebox-audio');
          for(const name of ['seeked','pause'])a.addEventListener(name,()=>window.playerSamples.push({name,time:a.currentTime,at:performance.now()}));
          // Last playing position of the mix: a cut-in resets currentTime before the pause event is observed.
          a.addEventListener('timeupdate',()=>{if(a.duration>1000)window.lastMasterTime=a.currentTime;});""")
        cmd(admin, 'playback.seek', {'entryId': master, 'positionSec': 600})
        until(lambda: audio(player)['time'] > 600 and not audio(player)['paused'])

        # 1. Requests only with ZERO ready requests, three times at different heartbeat phases (5 s cadence).
        errors = []
        for cycle, (idle_for, back) in enumerate([(1.2, 'master'), (7.0, 'auto'), (2.6, 'master')]):
            cmd(admin, 'queue.mode', {'mode': 'requests'})
            until(lambda: audio(player)['paused'] and snap()['schedule']['requestsIdle'])
            paused_at = audio(player)['time']
            time.sleep(idle_for)
            saved = snap()['suspendedMaster']['positionSec']
            assert snap()['nowPlaying'] is None and audio(player)['paused']
            checkpoint_error = abs(saved - paused_at)
            assert checkpoint_error < .35, (cycle, saved, paused_at)
            cmd(admin, 'queue.mode', {'mode': back})
            playing(player, 'master')
            until(lambda: audio(player)['time'] > saved + .5)
            resumed = last_seek(500)
            errors.append({'cycle': cycle, 'idleSec': idle_for, 'pausedAudioSec': paused_at, 'serverCheckpointSec': saved,
                           'checkpointErrorSec': round(checkpoint_error, 3), 'resumedSeekedSec': resumed,
                           'resumeErrorVsPausedAudioSec': round(abs(resumed - paused_at), 3), 'returnedTo': back})
            assert abs(resumed - paused_at) < .35, errors[-1]
            time.sleep(1.3 * cycle)  # shift the next cycle's phase against the heartbeat
        report['measurements'].append({'requestsOnlyIdleResume': errors})
        report['checks']['requestsOnlyEmptyCheckpointMatchesPausedAudio'] = True
        cmd(admin, 'queue.mode', {'mode': 'auto'})

        # 2. Play now interrupts the mix; the request ends natively; the mix resumes where it paused.
        request = cmd(attendee, 'request.submit', {'url': 'fixture:request'})['entryId']
        until(lambda: next(x for x in snap(admin)['requests'] if x['id'] == request)['status'] == 'ready', 60)
        quota = snap(attendee)['quota']['used']
        pauses_before = len([x for x in player.execute_script('return window.playerSamples') if x['name'] == 'pause'])
        cmd(admin, 'request.playNow', {'entryId': request})
        until(lambda: snap()['nowPlaying']['kind'] == 'request' and audio(player)['duration'] < 10 and not audio(player)['paused'])
        pause_sample = player.execute_script('return window.lastMasterTime')  # within one timeupdate (~250 ms) of the pause
        until(lambda: abs(snap()['suspendedMaster']['positionSec'] - pause_sample) < .6, 6)
        saved = snap()['suspendedMaster']['positionSec']
        playing(player, 'master')
        until(lambda: audio(player)['duration'] > 1000 and audio(player)['time'] > saved)
        resumed = last_seek(500)
        report['measurements'].append({'playNowResume': {'pausedAudioSec': pause_sample, 'serverCheckpointSec': saved, 'resumedSeekedSec': resumed,
                                                         'resumeErrorSec': round(abs(resumed - pause_sample), 3)}})
        assert abs(resumed - pause_sample) < .6
        s = snap()
        assert next(x for x in snap(admin)['requests'] if x['id'] == request)['status'] == 'played'
        assert snap(attendee)['quota']['used'] == quota, 'Play now does not change allowance'
        assert abs(s['schedule']['periodStartedAt'] - s['serverTime']) < 8000, 'fresh interval after the turn'
        report['checks']['playNowCutsInAndMixResumesAtPausedAudio'] = True

        # 3. Requests only: two real requests back to back, then silence; leaving resumes the mix.
        r1 = cmd(attendee, 'request.submit', {'url': 'fixture:aac'})['entryId']
        r2 = cmd(attendee, 'request.submit', {'url': 'fixture:request'})['entryId']
        until(lambda: all(x['status'] == 'ready' for x in snap(admin)['requests'] if x['id'] in (r1, r2)), 90)
        cmd(admin, 'queue.mode', {'mode': 'requests'})
        until(lambda: snap()['nowPlaying'] and snap()['nowPlaying']['entryId'] == r1 and audio(player)['duration'] == 8 and not audio(player)['paused'])
        until(lambda: snap()['nowPlaying'] and snap()['nowPlaying']['entryId'] == r2 and 3 < audio(player)['duration'] < 5, 30)
        report['checks']['requestsOnlyChainsRealRequestsBackToBack'] = True
        until(lambda: snap()['schedule']['requestsIdle'] and audio(player)['paused'], 30)  # r2 ends natively; nothing else ready
        assert snap()['suspendedMaster'] is not None
        time.sleep(6)
        assert audio(player)['paused'] and snap()['schedule']['requestsIdle']
        pins = http(worker_url + '/api/status')['assets']
        assert all(x['pinned'] for x in pins if x['source'] == 'fixture:master'), pins
        report['checks']['requestsOnlyIdleSilentAndMixPinned'] = True
        cmd(admin, 'queue.mode', {'mode': 'auto'})
        playing(player, 'master')

        # 4. The interval is real server time: 60 s with a ready request interrupts the mix automatically.
        r3 = cmd(admin, 'request.submit', {'url': 'fixture:request'})['entryId']  # the attendee's three are used
        until(lambda: next(x for x in snap(admin)['requests'] if x['id'] == r3)['status'] == 'ready', 60)
        anchor = snap()['schedule']['periodStartedAt']
        cmd(admin, 'queue.interval', {'periodMs': 60_000})
        assert snap()['schedule']['periodMs'] == 60_000 and snap()['schedule']['periodStartedAt'] == anchor
        until(lambda: snap()['nowPlaying']['kind'] == 'request', 90)
        s = snap()
        elapsed = s['serverTime'] - anchor
        report['measurements'].append({'intervalTurnElapsedMs': elapsed, 'configuredMs': 60_000})
        assert 59_000 <= elapsed <= 66_000, elapsed
        until(lambda: audio(player)['duration'] < 10 and not audio(player)['paused'])
        playing(player, 'master')
        cmd(admin, 'queue.interval', {'periodMs': None})
        assert snap()['schedule']['periodMs'] == 15 * 60_000
        report['checks']['configuredIntervalDrivesServerSideTurn'] = True
        report['events'] = [e['type'] for e in admin.execute_async_script("fetch('/api/v1/events?after=0').then(r=>r.json()).then(arguments[0])")['events'] if e['type'].startswith(('queue.', 'request.play', 'requests.'))]
        report['result'] = 'passed'
    except Exception as error:
        report['result'] = 'failed'
        report['error'] = repr(error)
        report['failureBrowsers'] = []
        for d in drivers:
            try:
                report['failureBrowsers'].append({'url': d.current_url, 'state': audio(d), 'text': d.find_element(By.TAG_NAME, 'body').text})
            except Exception:
                pass
        for i, log in enumerate(logs):
            log.flush(); log.seek(0)
            report.setdefault('failureLogs', {})[str(i)] = log.read()[-4000:]
        raise
    finally:
        report['finishedUTC'] = datetime.now(timezone.utc).isoformat()
        output = Path(args.output); output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(report, indent=2) + '\n')
        for d in reversed(drivers):
            try: d.quit()
            except Exception: pass
        for child in reversed(children):
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired: os.killpg(child.pid, signal.SIGKILL)
        for log in logs: log.close()
        temp.cleanup()
        subprocess.run(['pactl', 'unload-module', sink_module], check=False)
    print(json.dumps({k: report[k] for k in ['result', 'browser', 'checks', 'measurements']}, indent=2))


if __name__ == '__main__':
    main()
