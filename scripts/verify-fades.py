#!/usr/bin/env python3
"""Firefox evidence for real 7 s volume ramps and 3 s silent request boundaries.

Disposable identity/state/profiles, synthetic audio from the real worker, and a
private null sink. No provider traffic, live credentials, or venue/HDMI claim.
Run after bun run build: uv run --locked python scripts/verify-fades.py
"""
import argparse
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
import urllib.request
import uuid
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('player_helpers', ROOT / 'scripts/verify-player.py')
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
until, http, port = helpers.until, helpers.http, helpers.port


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='.local/fade-firefox-evidence.json')
    args = parser.parse_args()
    report = {'atUTC': datetime.now(timezone.utc).isoformat(), 'checks': {}, 'measurements': {},
              'scope': 'Headless Firefox, actual audio-only fixture files, dedicated null sink; no HDMI or audible claim'}
    sink = f'jukebox_fade_verify_{os.getpid()}'
    module = subprocess.check_output(['pactl', 'load-module', 'module-null-sink', f'sink_name={sink}'], text=True).strip()
    children, drivers, logs = [], [], []
    temp = tempfile.TemporaryDirectory(prefix='jukebox-fades-')
    work = Path(temp.name)
    app_port, worker_port = port(), port()
    app, worker = f'http://127.0.0.1:{app_port}', f'http://127.0.0.1:{worker_port}'

    def start(argv, env=None):
        log = open(work / f'{len(logs)}.log', 'w+')
        logs.append(log)
        child = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        children.append(child)

    def browser(path):
        options = Options(); options.add_argument('-headless')
        options.binary_location = '/usr/bin/firefox'
        driver = webdriver.Firefox(options=options, service=Service(env={**os.environ, 'PULSE_SINK': sink}, service_args=['--allow-system-access']))
        drivers.append(driver)
        driver.get(app + '/admin')
        for cookie in helpers.organizer_cookies(app): driver.add_cookie(cookie)
        helpers.allow_autoplay(driver, app)
        driver.get(app + path)
        return driver

    def command(driver, kind, payload=None):
        result = driver.execute_async_script('''const done=arguments[arguments.length-1];
          fetch('/api/v1/commands',{method:'POST',headers:{'content-type':'application/json'},
          body:JSON.stringify({commandId:arguments[0],type:arguments[1],payload:arguments[2]})})
          .then(r=>r.json()).then(done,e=>done({error:String(e)}));''', str(uuid.uuid4()), kind, payload or {})
        assert result.get('ok'), (kind, result)
        return result['result']

    def audio():
        return player.execute_script("const a=document.getElementById('jukebox-audio');return a?{paused:a.paused,volume:a.volume,time:a.currentTime,duration:a.duration,src:a.currentSrc}:null")

    try:
        start([sys.executable, '-m', 'jukebox.server', '--port', str(worker_port), '--data', str(work/'worker')])
        until(lambda: http(worker + '/api/status'), 30)
        env = {k:v for k,v in os.environ.items() if not k.startswith('JUKEBOX_')}
        env.update(NODE_ENV='test', PORT=str(app_port), JUKEBOX_ORIGIN=app, JUKEBOX_DEV_AUTH='1',
                   JUKEBOX_WORKER_URL=worker, JUKEBOX_SERVICE_DATA=str(work/'service'))
        start(['bun', '--no-env-file', 'scripts/start-web.ts'], env)
        until(lambda: http(app + '/healthz'), 30)
        admin = browser('/admin')
        master = command(admin, 'master.add', {'url': 'fixture:song'})['entryId']
        command(admin, 'night.open')
        request = command(admin, 'request.submit', {'url': 'fixture:request'})['entryId']
        def snap():
            return admin.execute_async_script("fetch('/api/v1/snapshot').then(r=>r.json()).then(arguments[0])")
        until(lambda: all(item['status']=='ready' for item in snap()['master']+snap()['requests']), 90)
        player = browser('/display')
        until(lambda: audio() and not audio()['paused'])
        report['browser'] = {k:player.capabilities.get(k) for k in ['browserName','browserVersion','moz:buildID']}
        master_src = audio()['src']
        command(admin, 'playback.seek', {'entryId':master,'positionSec':100})
        until(lambda: audio()['time']>=100)
        player.execute_script('''window.fadeEvents=[];const a=document.getElementById('jukebox-audio');
          const nativePause=a.pause;a.pause=function(){const playing=!a.paused;const result=nativePause.call(a);if(playing)window.fadeEvents.push({name:'pause-call',at:performance.now(),volume:a.volume,time:a.currentTime,src:a.currentSrc});return result;};
          for(const name of ['volumechange','pause','playing','ended','seeked'])a.addEventListener(name,()=>window.fadeEvents.push({name,at:performance.now(),volume:a.volume,time:a.currentTime,src:a.currentSrc}));''')
        command(admin, 'request.playNow', {'entryId':request})
        until(lambda: audio()['volume']<.6 and not audio()['paused'], 5)
        assert audio()['src']==master_src
        until(lambda: audio()['duration']<10 and not audio()['paused'], 20)
        paused_position = player.execute_script('return window.fadeEvents.find(e=>e.name==="pause-call").time')
        until(lambda: abs(snap()['suspendedMaster']['positionSec']-paused_position)<.15)
        checkpoint = snap()['suspendedMaster']['positionSec']
        until(lambda: audio()['src']==master_src and not audio()['paused'], 20)
        until(lambda: abs(audio()['volume']-.8)<.001, 12)
        events = player.execute_script('return window.fadeEvents')
        report['events']=events
        outgoing = next(e for e in events if e['name']=='volumechange' and e['src']==master_src and e['volume']<.799)
        paused = next(e for e in events if e['name']=='pause-call' and e['src']==master_src)
        request_play = next(e for e in events if e['name']=='playing' and e['src']!=master_src)
        ended = next(e for e in events if e['name']=='ended' and e['src']!=master_src)
        resumed = next(e for e in events if e['name']=='playing' and e['src']==master_src and e['at']>ended['at'])
        full = next(e for e in events if e['name']=='volumechange' and e['src']==master_src and e['at']>resumed['at'] and e['volume']>=.799)
        seeked = next(e for e in events if e['name']=='seeked' and e['src']==master_src and e['at']>ended['at'])
        measured = {'masterFadeOutMs':paused['at']-outgoing['at'], 'silenceBeforeRequestMs':request_play['at']-paused['at'],
                    'silenceAfterRequestMs':resumed['at']-ended['at'], 'masterFadeInMs':full['at']-resumed['at'],
                    'actualPausedMasterSec':paused['time'], 'savedMasterSec':checkpoint, 'resumedSeekSec':seeked['time']}
        report['measurements'] = measured
        assert 6500<=measured['masterFadeOutMs']<=7600, measured
        assert 2900<=measured['silenceBeforeRequestMs']<=4200, measured
        assert 2900<=measured['silenceAfterRequestMs']<=4200, measured
        assert 6500<=measured['masterFadeInMs']<=7600, measured
        assert abs(paused['time']-checkpoint)<.15 and abs(seeked['time']-checkpoint)<.15, measured
        assert request_play['volume']==.8 and resumed['volume']==0
        assert request_play['time']<.15, 'silent preload must not consume the start of the request'
        assert all(e['volume']==.8 for e in events if e['name']=='volumechange' and request_play['at']<=e['at']<ended['at']), 'request must never fade out'
        assert next(item for item in snap()['requests'] if item['id']==request)['status']=='played'
        assert admin.execute_script("return document.querySelectorAll('audio,video').length===0")
        report['checks'] = {k:True for k in ['sevenSecondMasterFadeOut','threeSecondPreRequestSilence',
                          'requestAtNormalVolume','requestHasNoFadeOut','threeSecondPostRequestSilence','sevenSecondMasterFadeIn',
                          'actualPausedCheckpointResumed','requestMarkedPlayed','adminSilent']}
        report['result']='passed'
    except Exception as error:
        report['result']='failed'; report['error']=repr(error)
        for i, log in enumerate(logs):
            log.flush(); log.seek(0); report.setdefault('failureLogs',{})[str(i)] = log.read()[-4000:]
        raise
    finally:
        report['finishedUTC']=datetime.now(timezone.utc).isoformat()
        output=Path(args.output);output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2)+'\n')
        for driver in reversed(drivers):
            try:driver.quit()
            except Exception:pass
        for child in reversed(children):
            if child.poll() is None:
                os.killpg(child.pid,signal.SIGTERM)
                try:child.wait(timeout=5)
                except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL)
        for log in logs:log.close()
        temp.cleanup()
        subprocess.run(['pactl','unload-module',module],check=False)
    print(json.dumps(report,indent=2))


if __name__=='__main__':main()
