#!/usr/bin/env python3
"""Real Firefox + worker evidence. Fresh profiles, no autoplay overrides.

Uses production lease/heartbeat policies. An isolated service fixture can advance
only the scheduling anchor, avoiding fifteen-minute waits without changing leases.
Admin commands use fetch in a separate Firefox profile with its own login cookie.
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
    parser.add_argument('--output', default='.local/player-firefox-evidence.json')
    parser.add_argument('--dev-smoke', action='store_true', help='Smoke the actual scripts/run-dev --worker path on :5173')
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
    wp, sp, ap = port(), port(), (5173 if args.dev_smoke else port())
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

    def measure(kind, payload, expect):
        before = snap()['playback']['desiredEpoch']
        began = time.monotonic()
        cmd(admin, kind, payload)
        until(lambda: snap()['playback']['ackedEpoch'] >= before + 1 and expect())
        report['measurements'].append({'command': kind, 'commandToServerObservedAckMs': round((time.monotonic()-began)*1000, 2)})

    try:
        worker = start([sys.executable, '-m', 'jukebox.server', '--port', str(wp), '--data', str(work/'worker')])
        until(lambda: http(worker_url + '/api/status'), 30)
        service_args = ['node', 'scripts/player-fixture-server.ts', '--port', str(sp), '--worker', worker_url,
                        '--data', str(work/'service'), '--origin', app]
        env = {**os.environ, 'JUKEBOX_SERVICE': service_url}
        if args.dev_smoke:
            service = start(['./scripts/run-dev', '--worker', worker_url, '--port', str(sp), '--data', str(work/'service')], env)
            report['runtime']='scripts/run-dev --worker (production service/policies)'
        else:
            service = start(service_args)
            start([str(ROOT/'node_modules/.bin/vite'), '--port', str(ap), '--strictPort'], env)
            report['runtime']='isolated test service; production lease/heartbeat; injected scheduling anchor'
        until(lambda: http(service_url + '/healthz'), 30)
        until(lambda: urllib.request.urlopen(app+'/display', timeout=2).status == 200, 30)
        admin = browser('/admin')
        login(admin, 'phase3_admin', True)
        attendee = browser('/queue')
        login(attendee, 'phase3_attendee')
        cmd(admin, 'night.open')
        master = cmd(admin, 'master.add', {'url': 'fixture:master'})['entryId']
        song = cmd(admin, 'master.add', {'url': 'fixture:song'})['entryId']
        request = cmd(attendee, 'request.submit', {'url': 'fixture:request'})['entryId']
        until(lambda: all(x['status']=='ready' for x in snap(admin)['master']+snap(admin)['requests']), 90)
        player = browser('/display')
        report['browser'] = {k: player.capabilities.get(k) for k in ['browserName','browserVersion','moz:buildID','moz:geckodriverVersion','platformName','moz:headless']}
        assert report['browser']['browserName'] == 'firefox'
        until(lambda: audio(player)['generation'])
        until(lambda: player.find_elements(By.ID, 'player-activate'))
        assert audio(player)['paused']
        report['checks']['automaticallyConnectedButFirefoxAwaitsSoundPermission'] = True
        click(player, 'player-activate')
        assert audio(player)['paused']
        report['checks']['ordinaryClaimWaitsPriorLeaseBeforeAudio'] = True
        playing(player)
        # Check the sound server, not just the environment variable. Firefox's
        # stream identifies its parent process, which Selenium owns.
        sink_index = next(line.split()[0] for line in subprocess.check_output(
            ['pactl', 'list', 'short', 'sinks'], text=True).splitlines() if line.split()[1]==sink_name)
        def routed_stream():
            streams = json.loads(subprocess.check_output(['pactl', '-f', 'json', 'list', 'sink-inputs'], text=True))
            return any(str(s['sink'])==sink_index and s.get('properties', {}).get('application.process.id')==str(player.capabilities['moz:processID']) for s in streams)
        until(routed_stream)
        report['checks']['ownedFirefoxOutputVerifiedOnNullSink'] = True
        # Firefox WebDriver evaluation has its own module realm. Install a normal
        # page module so this observer shares the visualizer's actual singleton.
        player.execute_script("""const s=document.createElement('script');s.type='module';s.textContent=`
          import {subscribeAnalyser} from '/src/shared/audio-tap.ts';
          let analyser=null;subscribeAnalyser(a=>analyser=a);
          function sample(){
            let rms=0;if(analyser){const v=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(v);rms=Math.sqrt(v.reduce((s,x)=>s+x*x,0)/v.length);}
            window.playerAnalysis={exists:!!analyser,state:analyser?.context.state,rms};requestAnimationFrame(sample);
          }sample();`;document.head.append(s);""")
        def rms():
            return player.execute_script('return window.playerAnalysis?.rms||0')
        until(lambda: rms()>.001)
        report['measurements'].append({'masterAnalysisRms':rms()})
        for d in (admin, attendee):
            assert d.execute_script("return document.querySelectorAll('audio,video').length===0")
        report['checks']['separateAdminAttendeeProfilesSilent'] = True
        # Read-only event observations: seeked captures the exact pre-play position.
        player.execute_script('''window.playerSamples=[];const a=document.getElementById('jukebox-audio');
          for(const name of ['seeked','playing','ended'])a.addEventListener(name,()=>window.playerSamples.push({name,time:a.currentTime,src:a.currentSrc,at:performance.now()}));''')
        measure('playback.pause', {}, lambda: audio(player)['paused'])
        measure('playback.seek', {'entryId': master, 'positionSec': 1234.5}, lambda: abs(audio(player)['time']-1234.5)<.05)
        measure('playback.volume', {'volume': .17}, lambda: player.execute_script("return document.getElementById('jukebox-audio').volume===.17"))
        measure('playback.play', {}, lambda: not audio(player)['paused'])
        if args.dev_smoke:
            report['result']='passed'
            return
        due()
        until(lambda: snap()['nowPlaying']['kind']=='request' and audio(player)['duration']<10 and not audio(player)['paused'])
        until(lambda: snap()['playback']['observed']['loadId']==int(audio(player)['loadId']))
        until(lambda: rms()>.001)
        report['measurements'].append({'requestAnalysisRms':rms()})
        saved = snap()['suspendedMaster']['positionSec']
        pins = http(worker_url+'/api/status')['assets']
        assert all(x['pinned'] for x in pins)
        report['checks']['suspendedMasterPinned'] = True
        playing(player, 'master')
        until(lambda: audio(player)['duration']>1000 and audio(player)['time']>saved)
        samples = player.execute_script('return window.playerSamples')
        resumed = [x for x in samples if x['name']=='seeked' and x['time']>1200][-1]['time']
        assert abs(resumed-saved)<.05
        report['measurements'].append({'resumeRequestedSec': saved,'resumeActualSeekedSec': resumed,'resumeErrorSec': abs(resumed-saved)})
        assert next(x for x in snap(admin)['requests'] if x['id']==request)['status']=='played'
        report['checks']['oneRequestNativeEndedThenMixResumed'] = True
        print('Passed mix/request/resume and remote commands', flush=True)
        # Exactly-six-minute normal song, with a second request and reload mid-request.
        request2 = cmd(attendee, 'request.submit', {'url':'fixture:aac'})['entryId']
        until(lambda: next(x for x in snap(admin)['requests'] if x['id']==request2)['status']=='ready', 60)
        cmd(admin, 'playback.skip', {'entryId': master})
        until(lambda: audio(player)['duration']==360 and snap()['nowPlaying']['entryId']==song)
        due()
        time.sleep(.5)
        assert snap()['nowPlaying']['entryId']==song and snap()['schedule']['turnDue']
        cmd(admin, 'playback.seek', {'entryId':song,'positionSec':358.5})
        until(lambda: audio(player)['time']>358)
        until(lambda: snap()['nowPlaying']['kind']=='request' and audio(player)['duration']==8)
        playing(player, 'request')
        cmd(admin, 'playback.pause')
        until(lambda: audio(player)['paused'] and snap()['playback']['confirmation']=='confirmed')
        request_position = audio(player)['time']
        quota = snap(attendee)['quota']['used']
        player.refresh()
        until(lambda: audio(player)['generation'], 25)
        until(lambda: audio(player)['duration']==8)
        assert audio(player)['paused'] and abs(audio(player)['time']-request_position)<.35
        if player.find_elements(By.ID, 'player-activate'): click(player, 'player-activate')
        cmd(admin, 'playback.play')
        playing(player, 'request')
        playing(player, 'master')
        assert snap(attendee)['quota']['used']==quota
        report['checks']['normalSongEndedBeforeRequest'] = True
        report['checks']['refreshMidRequestRestoredWithoutDoubleCharge'] = True
        print('Passed normal song and mid-request refresh', flush=True)
        # Remove the actual newly-prepared file BEFORE its first browser load.
        # Re-preparing the same fixture produces a new asset ID, avoiding cached bytes.
        failed = cmd(attendee, 'request.submit', {'url':'fixture:request'})['entryId']
        until(lambda: next(x for x in snap(admin)['requests'] if x['id']==failed)['status']=='ready', 60)
        assets = http(worker_url+'/api/status')['assets']
        # Most recent request asset belongs to this submission; find via persisted
        # fixture service inspection is unnecessary: worker creation order is retained.
        requests = [a for a in assets if a['source']=='fixture:request']
        asset = requests[-1]
        broken = work/'worker'/'assets'/asset['id']/asset['file']
        held = broken.with_suffix('.held')
        broken.rename(held)
        try:
            due()
            until(lambda: next(x for x in snap(admin)['requests'] if x['id']==failed)['status']=='failed', 25)
            playing(player, 'master')
            assert snap(attendee)['quota']['used']==quota
            errors=admin.execute_async_script("fetch('/api/v1/events?after=0').then(r=>r.json()).then(arguments[0])")['events']
            assert len([e for e in errors if e['type']=='player.error' and e['data'].get('entryId')==failed])==2
        finally:
            held.rename(broken)
        report['checks']['missingAssetTwoAttemptsRefundAndReturn'] = True
        print('Passed missing asset failure/refund', flush=True)
        # A second display connects in the background but cannot displace live audio.
        other = browser('/display')
        until(lambda: 'another display' in other.find_element(By.TAG_NAME, 'body').text)
        assert audio(other)['paused'] and not audio(other)['generation']
        assert not audio(player)['paused']
        other.quit(); drivers.remove(other)
        report['checks']['secondDisplayCannotStealOrPlay'] = True
        load_before = audio(player)['loadId']
        service.terminate(); service.wait(timeout=8)
        time.sleep(.5)
        service = start(service_args)
        until(lambda: http(service_url+'/healthz'))
        playing(player)
        until(lambda: snap()['playback']['confirmation']=='confirmed')
        assert audio(player)['loadId']==load_before
        report['checks']['shortReconnectKeepsLoad'] = True
        # Service loss silences the old lease; the same laptop reconnects itself.
        service.terminate(); service.wait(timeout=8)
        began=time.monotonic()
        until(lambda: audio(player)['paused'] and not audio(player)['generation'], 17)
        report['measurements'].append({'outageToSilenceObservedMs':round((time.monotonic()-began)*1000,2)})
        service=start(service_args)
        until(lambda: http(service_url+'/healthz'))
        playing(player)
        report['checks']['leaseExpirySilencesThenAutomaticallyReconnectsWithoutAnotherClick'] = True
        # Real session end clears the page and stops sound; next session resumes on this laptop.
        # Hold ONLY the player's closed-night snapshots. The public display feed
        # still arrives; its empty-night render must synchronously stop the audio.
        player.execute_script("""
          window.privateCloseHeld=0;
          const pending=[];
          let hold=true;
          const originalRead=ReadableStreamDefaultReader.prototype.read;
          const originalFetch=window.fetch;
          const closed=s=>s?.role==='player' && s.night?.status==='closed';
          const delay=value=>{window.privateCloseHeld++;return new Promise(resolve=>pending.push(()=>resolve(value)))};
          ReadableStreamDefaultReader.prototype.read=function(...args){
            return originalRead.apply(this,args).then(result=>{
              if(hold && typeof result.value==='string'){
                for(const line of result.value.split('\\n')){
                  if(!line.startsWith('data: '))continue;
                  try{if(closed(JSON.parse(line.slice(6))))return delay(result)}catch{}
                }
              }
              return result;
            });
          };
          window.fetch=async(url,init)=>{
            const response=await originalFetch(url,init);
            if(hold && url==='/api/v1/snapshot' && new Headers(init?.headers).has('authorization')){
              try{if(closed(await response.clone().json()))return delay(response)}catch{}
            }
            return response;
          };
          window.releasePrivateClose=()=>{
            hold=false;window.fetch=originalFetch;
            ReadableStreamDefaultReader.prototype.read=originalRead;
            for(const resolve of pending)resolve();
          };
        """)
        # An already pending stream read predates the shim; let an open-night
        # heartbeat consume it so the closed-night frame is actually intercepted.
        time.sleep(5.5)
        cmd(admin, 'night.close')
        until(lambda: player.find_elements(By.CSS_SELECTOR, '.display-idle[data-state=idle]'))
        assert audio(player)['paused']
        until(lambda: player.execute_script('return window.privateCloseHeld>0'), 8)
        player.execute_script('window.releasePrivateClose()')
        report['checks']['publicNightCloseStopsAudioWithPrivateCloseSnapshotsHeld'] = True
        assert not player.find_elements(By.CSS_SELECTOR, '.display-now,.display-request')
        cmd(admin, 'night.open')
        playing(player)
        assert not player.find_elements(By.ID, 'player-activate')
        report['checks']['endClearsDisplayThenStartResumesWithoutAnotherClick'] = True
        # A delayed pre-claim snapshot from a separate fetch must not override
        # the claim's revision or the newer SSE generation.
        player.execute_script("""window.originalFetch=window.fetch;window.oldSnapshotDelivered=false;
          window.fetch=(url,init)=>{
            if(url==='/api/v1/snapshot' && !window.oldSnapshotDelivered){
              window.oldSnapshotDelivered=true;
              return Promise.resolve(new Response(JSON.stringify({revision:0,lease:null,desired:null})));
            }
            return window.originalFetch(url,init);
          };""")
        until(lambda: player.execute_script('return window.oldSnapshotDelivered'), 8)
        time.sleep(.2)
        assert audio(player)['generation'] and not audio(player)['paused']
        player.execute_script('window.fetch=window.originalFetch')
        report['checks']['delayedPreclaimSnapshotIgnored']=True
        # Declared synthetic transport response tests the STALE_LEASE path itself,
        # independently of the real SSE generation fencing above.
        player.execute_script("""window.originalFetch=window.fetch;window.fetch=(url,init)=>{
          if(init?.body && JSON.parse(init.body).type==='player.report')return Promise.resolve(new Response(JSON.stringify({ok:false,error:{code:'STALE_LEASE',message:'Synthetic stale report',retryable:false}}),{status:409}));
          return window.originalFetch(url,init);
        };""")
        until(lambda: audio(player)['paused'] and not audio(player)['generation'])
        player.execute_script('window.fetch=window.originalFetch')
        report['checks']['syntheticStaleLeaseReportSilencesLocalAudio']=True
        playing(player)
        # Exhaust the usable master list with an actual newly-prepared broken
        # asset. Terminal acknowledgement must not stop silent lease heartbeats.
        for entry in snap(admin)['master']:
            cmd(admin, 'master.remove', {'entryId': entry['id']})
        idle_master = cmd(admin, 'master.add', {'url': 'fixture:request'})['entryId']
        until(lambda: next(x for x in snap(admin)['master'] if x['id']==idle_master)['status']=='ready', 60)
        asset = [a for a in http(worker_url+'/api/status')['assets'] if a['source']=='fixture:request'][-1]
        broken = work/'worker'/'assets'/asset['id']/asset['file']
        held = broken.with_suffix('.held')
        broken.rename(held)
        try:
            cmd(admin, 'playback.play')
            until(lambda: next(x for x in snap(admin)['master'] if x['id']==idle_master)['status']=='unusable', 25)
            idle_generation = audio(player)['generation']
            assert idle_generation and audio(player)['paused']
            time.sleep(16)
            assert audio(player)['generation']==idle_generation and audio(player)['paused']
            assert snap()['playback']['observed']['status']=='paused'
            events = admin.execute_async_script("fetch('/api/v1/events?after=0').then(r=>r.json()).then(arguments[0])")['events']
            assert len([e for e in events if e['type']=='player.error' and e['data'].get('entryId')==idle_master])==2
        finally:
            held.rename(broken)
        report['checks']['exhaustedMasterStaysSilentAndRenewsWithoutRepeatedErrors']=True
        report['events'] = admin.execute_async_script("fetch('/api/v1/events?after=0').then(r=>r.json()).then(arguments[0])")['events']
        report['result']='passed'
    except Exception as error:
        report['result']='failed'
        report['error']=repr(error)
        report['failureBrowsers']=[]
        for d in drivers:
            try:
                report['failureBrowsers'].append({'url':d.current_url,'state':audio(d),'text':d.find_element(By.TAG_NAME,'body').text,'analysis':d.execute_script("return window.playerAnalysis")})
            except Exception:
                pass
        for i, log in enumerate(logs):
            log.flush(); log.seek(0)
            report.setdefault('failureLogs',{})[str(i)] = log.read()[-8000:]
        raise
    finally:
        report['finishedUTC']=datetime.now(timezone.utc).isoformat()
        output=Path(args.output);output.parent.mkdir(parents=True,exist_ok=True)
        output.write_text(json.dumps(report,indent=2)+'\n')
        for d in reversed(drivers):
            try: d.quit()
            except Exception: pass
        for child in reversed(children):
            if child.poll() is None:
                os.killpg(child.pid,signal.SIGTERM)
                try: child.wait(timeout=5)
                except subprocess.TimeoutExpired: os.killpg(child.pid,signal.SIGKILL)
        for log in logs: log.close()
        temp.cleanup()
        subprocess.run(['pactl', 'unload-module', sink_module], check=False)
    print(json.dumps({k:report[k] for k in ['result','browser','checks','measurements']},indent=2))


if __name__=='__main__':
    main()
