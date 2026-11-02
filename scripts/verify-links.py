#!/usr/bin/env python3
"""Opt-in live catalog -> matcher -> worker -> app/Firefox verification.

Own ports, temporary data and fresh Firefox profiles; labelled fake identity only
inside this isolated test. Public provider traffic is bounded by runtime limits.
Never reads PH ID credentials, personal browser profiles or the user's app state.
"""
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import uuid
import urllib.request
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('player_verify', Path(__file__).with_name('verify-player.py'))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
until, http, port = helpers.until, helpers.http, helpers.port
SPOTIFY = 'https://open.spotify.com/track/1OAFmguvHB2OI2AMYXpmyG'
APPLE = 'https://music.apple.com/us/album/a-new-kind-of-love/1634848028?i=1634848035&ls=1&app=music'
RADIO = 'https://www.youtube.com/watch?v=yL-4oSQwzJI&list=RDyL-4oSQwzJI&start_radio=1'
SHARE = 'https://youtu.be/yL-4oSQwzJI?si=8CHNKPEO_BGB5vk6'


class ExternalSourceBlocked(Exception):
    def __init__(self, stage, error):
        super().__init__(f'{stage}: {error.get("message", "provider unavailable")}')
        self.stage = stage


def main():
    report = {'atUTC': datetime.now(timezone.utc).isoformat(), 'checks': {}, 'providers': {},
              'hardware': 'Headless Firefox, dedicated null audio sink; HDMI/wall untested',
              'identity': 'Labelled fake identity on isolated test ports only',
              'runtime': 'scripts/run-dev WITHOUT --worker (auto-starts real worker)'}
    drivers = []
    sink = f'jukebox_links_{os.getpid()}'
    module = subprocess.check_output(['pactl', 'load-module', 'module-null-sink', f'sink_name={sink}'], text=True).strip()
    os.environ['PULSE_SINK'] = sink
    output = ROOT / '.local/links-app-evidence.json'
    output.parent.mkdir(exist_ok=True)
    process = None
    with tempfile.TemporaryDirectory(prefix='jukebox-links-') as temp:
        work = Path(temp)
        sp, ap, wp = port(), port(), port()
        app, service, worker = f'http://127.0.0.1:{ap}', f'http://127.0.0.1:{sp}', f'http://127.0.0.1:{wp}'
        # No secrets are copied into the test; fixtures do not alter the user's auth.
        env = {k: v for k, v in os.environ.items() if not k.startswith('JUKEBOX_')}
        env.update(JUKEBOX_SERVICE_PORT=str(sp), JUKEBOX_APP_PORT=str(ap), JUKEBOX_WORKER_PORT=str(wp), JUKEBOX_WORKER_DATA=str(work / 'worker'))
        log = (work / 'startup.log').open('w+')

        def browser(path):
            options = Options(); options.add_argument('-headless'); options.binary_location = '/usr/bin/firefox'
            driver = webdriver.Firefox(options=options)
            drivers.append(driver); driver.set_script_timeout(70); driver.set_window_size(1100, 1000)
            driver.get(app + path)
            return driver

        def command(driver, kind, payload=None, command_id=None):
            return driver.execute_async_script('''const done=arguments[arguments.length-1];
              fetch('/api/v1/commands',{method:'POST',headers:{'content-type':'application/json'},
                body:JSON.stringify({commandId:arguments[0],type:arguments[1],payload:arguments[2]})})
                .then(r=>r.json()).then(done,e=>done({transportError:String(e)}));''', command_id or str(uuid.uuid4()), kind, payload or {})

        def ok(driver, kind, payload=None):
            response = command(driver, kind, payload)
            if not response.get('ok') and response.get('error', {}).get('code') == 'SOURCE_UNAVAILABLE' and response['error'].get('retryable'):
                raise ExternalSourceBlocked(kind, response['error'])
            assert response.get('ok'), (kind, response)
            return response['result']

        def snapshot(driver):
            return driver.execute_async_script("fetch('/api/v1/snapshot').then(r=>r.json()).then(arguments[0])")

        def check_link(driver, url):
            another = driver.find_elements(By.XPATH, "//button[normalize-space()='Request another']")
            if another: another[0].click()
            until(lambda: driver.find_elements(By.ID, 'q-link'))
            field = driver.find_element(By.ID, 'q-link'); field.clear(); field.send_keys(url)
            driver.find_element(By.CSS_SELECTOR, 'form button[type=submit]').click()
            until(lambda: not driver.find_elements(By.XPATH, "//button[normalize-space()='Checking…']"), 65)
            return driver.find_element(By.TAG_NAME, 'body').text

        try:
            process = subprocess.Popen(['./scripts/run-dev', '--data', str(work / 'service')], cwd=ROOT, env=env,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            until(lambda: http(service + '/healthz'), 45)
            until(lambda: http(app + '/healthz'), 30)
            report['checks']['defaultStartupOwnWorker'] = bool(http(worker + '/api/status')['limits'])
            admin = browser('/auth/login?returnTo=/queue')
            report['browser'] = {k: admin.capabilities.get(k) for k in ['browserName', 'browserVersion', 'moz:buildID']}
            until(lambda: admin.find_elements(By.NAME, 'sub'))
            admin.find_element(By.NAME, 'sub').send_keys('links_test_organizer')
            admin.find_element(By.NAME, 'roles').click()
            admin.find_element(By.TAG_NAME, 'button').click()
            until(lambda: '/queue' in admin.current_url)
            ok(admin, 'night.open')
            # Record preview identity/matching reasons before UI submission.
            preview = ok(admin, 'request.preview', {'url': SPOTIFY})
            report['providers']['spotify'] = preview
            text = check_link(admin, SPOTIFY)
            assert 'Ghost Funk Orchestra' in text and '4:34' in text, text
            add = admin.find_element(By.XPATH, "//button[starts-with(normalize-space(),'Add to queue')]")
            add.click()
            until(lambda: snapshot(admin)['quota']['used'] == 1)
            request = until(lambda: next((r for r in snapshot(admin)['requests'] if r['status'] == 'ready'), None), 90)
            assert request['durationSec'] < 360
            report['checks']['spotifyUiSubmitPrepared'] = True
            apple_preview = ok(admin, 'request.preview', {'url': APPLE})
            report['providers']['apple_music'] = apple_preview
            assert apple_preview['source']['recordingKey'] == preview['source']['recordingKey']
            assert apple_preview['verdict'].get('code') == 'DUPLICATE_REQUEST', apple_preview
            text = check_link(admin, APPLE)
            assert 'Already' in text or 'already' in text, text
            duplicate = command(admin, 'request.submit', {'url': APPLE})
            assert duplicate['error']['code'] == 'DUPLICATE_REQUEST'
            assert snapshot(admin)['quota']['used'] == 1
            report['checks']['appleSameRecordingDuplicateNoCharge'] = True
            for url in [RADIO, SHARE]:
                rejected = command(admin, 'request.submit', {'url': url})
                assert rejected['error']['code'] == 'DURATION_REJECTED', rejected
            assert snapshot(admin)['quota']['used'] == 1
            playlist = command(admin, 'request.preview', {'url': 'https://www.youtube.com/playlist?list=RDyL-4oSQwzJI'})
            assert playlist['error']['code'] == 'SOURCE_UNSUPPORTED'
            report['checks']['reportedMixFullDurationNoChargeAndPlaylistRejected'] = True
            master_id = ok(admin, 'master.add', {'url': SHARE})['entryId']
            until(lambda: any(m['id'] == master_id and m['status'] == 'ready' for m in snapshot(admin)['master']), 90)
            assets = http(worker + '/api/status')['assets']
            report['assets'] = assets
            assert len(assets) == 2
            for asset in assets:
                assert asset['selection']['format_id'] == '251' and asset['selection']['vcodec'] == 'none'
                assert len(asset['streams']) == 1 and asset['streams'][0]['type'] == 'audio'
                ranged = urllib.request.Request(app + asset['url'], headers={'Range': 'bytes=0-99'})
                with urllib.request.urlopen(ranged, timeout=5) as response:
                    assert response.status == 206 and len(response.read()) == 100
            display = browser('/display')
            until(lambda: display.find_elements(By.ID, 'player-activate'))
            display.find_element(By.ID, 'player-activate').click()
            until(lambda: display.execute_script("const a=document.querySelector('audio');return a&&!a.paused&&a.currentTime>0&&a.duration>3000"), 30)
            assert display.execute_script("return document.querySelectorAll('audio').length===1 && document.querySelectorAll('video').length===0")
            ok(admin, 'playback.pause')
            until(lambda: display.execute_script("return document.querySelector('audio').paused"))
            ok(admin, 'playback.seek', {'entryId': master_id, 'positionSec': 1234.5})
            actual = until(lambda: display.execute_script("const a=document.querySelector('audio');return Math.abs(a.currentTime-1234.5)<.35&&a.currentTime"))
            report['checks']['appFirefoxOpus251SeekErrorSeconds'] = abs(actual - 1234.5)
            report['checks']['adminAndAttendeeSilent'] = admin.execute_script("return document.querySelectorAll('audio,video').length===0")
            report['browser'] = {k: display.capabilities.get(k) for k in ['browserName', 'browserVersion', 'moz:buildID']}
            ok(admin, 'night.close')
            until(lambda: display.execute_script("return document.querySelector('audio').paused"))
            report['result'] = 'passed'
        except Exception as exc:
            report['result'] = 'external-source-blocked' if isinstance(exc, ExternalSourceBlocked) else 'failed'
            if isinstance(exc, ExternalSourceBlocked): report['blockedStage'] = exc.stage
            report['error'] = repr(exc)
            raise
        finally:
            output.write_text(json.dumps(report, indent=2) + '\n')
            for driver in drivers: driver.quit()
            if process:
                os.killpg(process.pid, signal.SIGTERM)
                try: process.wait(timeout=15)
                except subprocess.TimeoutExpired: os.killpg(process.pid, signal.SIGKILL); process.wait()
            subprocess.run(['pactl', 'unload-module', module], check=False)
            log.close()
    print(json.dumps(report['checks'], indent=2))


if __name__ == '__main__': main()
