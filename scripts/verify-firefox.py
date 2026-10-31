#!/usr/bin/env python3
"""Exercise real Firefox with a new temporary profile; never reads user profiles.

Uses the browser explicitly required by the Phase-1 brief, rather than treating
T3's Chromium preview as Firefox evidence. Player controls use visible UI;
diagnostics, the autoplay attempt, and declared fault injection use evaluation.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import socket
import subprocess
import sys
import time
import tempfile
import urllib.error
import urllib.request
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support.ui import Select, WebDriverWait

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-url', help='Existing loopback proof server; otherwise launch an isolated one')
    parser.add_argument('--output', default='.local/firefox-evidence.json')
    parser.add_argument('--headed', action='store_true')
    args = parser.parse_args()
    process = None
    temporary = None
    if args.base_url:
        base = args.base_url.rstrip('/')
    else:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
        base = f'http://127.0.0.1:{port}'
        (ROOT/'.local').mkdir(exist_ok=True)
        temporary = tempfile.TemporaryDirectory(prefix='firefox-',dir=ROOT/'.local')
        data = Path(temporary.name)
        process = subprocess.Popen([sys.executable,'-m','jukebox.server','--port',str(port),'--data',str(data)],cwd=ROOT)

    def api(path,body=None):
        request=urllib.request.Request(base+'/api/'+path, data=json.dumps(body).encode() if body is not None else None,
                                       headers={'Content-Type':'application/json'} if body is not None else {})
        with urllib.request.urlopen(request,timeout=5) as response: return json.load(response)

    def wait_server():
        for _ in range(100):
            try: return api('status')
            except OSError: time.sleep(.1)
        raise AssertionError('Local server did not start')

    report = {'atUTC':datetime.now(timezone.utc).isoformat(),'checks':{},'measurements':[],
              'hardware':'Development Linux; no HDMI/wall listening claim', 'headless':not args.headed}
    driver = None
    try:
        status=wait_server()
        # Each independent run starts from an explicitly released/cleared prior
        # checkpoint, or a pristine server. A still-active human tab is not evicted.
        if status['player']['state']['masterId']:
            raise AssertionError('Verification server has a checkpoint; clear it in its page first or use fresh --data')
        required=[('fixture:master','master'),('fixture:request','request'),('fixture:song','master'),('fixture:aac','request')]
        prepared={}
        for source,kind in required:
            existing=next((a for a in api('status')['assets'] if a['source']==source and a['kind']==kind and (source!='fixture:song' or a['duration']==360)),None)
            if not existing:
                job=api('prepare',{'source':source,'kind':kind})
                deadline=time.monotonic()+150
                while time.monotonic()<deadline:
                    status=api('status'); state=next(j for j in status['jobs'] if j['id']==job['id'])
                    if state['status']=='failed': raise AssertionError(state['error'])
                    if state['status']=='ready':
                        existing=next(a for a in status['assets'] if a['id']==job['id']); break
                    time.sleep(.2)
                else: raise AssertionError('Preparation deadline exceeded')
            prepared[source]=existing
            print(f"Prepared {source}: {existing['codec']} {existing['duration']}s in {existing['preparationSeconds']}s",flush=True)
        report['assets']=list(prepared.values())
        options=Options()
        if not args.headed: options.add_argument('-headless')
        options.binary_location='/usr/bin/firefox'
        driver=webdriver.Firefox(options=options)  # Selenium Manager installs driver if needed; fresh profile
        driver.set_window_size(1280,1000)
        driver.set_script_timeout(15)
        report['browser']={k:driver.capabilities.get(k) for k in ['browserName','browserVersion','moz:buildID','moz:geckodriverVersion','platformName','moz:headless']}
        assert report['browser']['browserName']=='firefox'
        driver.get(base+'/display')
        wait=WebDriverWait(driver,15,poll_frequency=.05)
        wait.until(lambda d:d.execute_script('return !!window.proof?.inspect().state'))
        inspect=lambda:driver.execute_script('return window.proof.inspect()')
        report['userAgent']=driver.execute_script('return navigator.userAgent')
        assert inspect()['paused'] and not inspect()['owned']
        report['checks']['opensSilent']=True
        report['codecSupport']=driver.execute_script("return ['audio/webm; codecs=opus','audio/mp4; codecs=mp4a.40.2'].map(type=>({type,answer:document.getElementById('audio').canPlayType(type)}))")
        report['autoplayAttempt']=driver.execute_async_script('''
          const done=arguments[arguments.length-1], a=document.getElementById('audio');
          a.src=arguments[0];
          a.play().then(()=>{a.pause();done({allowed:true});},e=>done({allowed:false,name:e.name,message:e.message}));
        ''',prepared['fixture:master']['url'])
        driver.refresh(); wait.until(lambda d:d.execute_script('return !!window.proof?.inspect().state'))
        def click(id): driver.find_element(By.ID,id).click()
        def choose(id,source): Select(driver.find_element(By.ID,id)).select_by_value(prepared[source]['id'] if source else '')
        def seek(seconds):
            el=driver.find_element(By.ID,'seek');el.clear();el.send_keys(str(seconds));click('seekButton')
            wait.until(lambda d:abs(inspect()['currentTime']-seconds)<.35)
        def playing(role='master'):
            wait.until(lambda d:inspect()['owned'] and inspect()['state']['role']==role and not inspect()['paused'] and not inspect()['swapping'])
        def pause():
            click('pause'); wait.until(lambda d:inspect()['state']['paused'] and inspect()['paused'])
        def reset():
            click('reset');wait.until(lambda d:not inspect()['owned'] and inspect()['state']['masterId'] is None)
        def expect_http_conflict(path,body):
            try: api(path,body)
            except urllib.error.HTTPError as e:
                assert e.code==409;e.close();return
            raise AssertionError('Expected pinned-asset rejection')

        choose('master','fixture:master');choose('request','fixture:request');click('activate');playing()
        wait.until(lambda d:inspect()['peakRms']>.01)
        report['checks']['masterAudioAnalysisRms']=inspect()['rms']
        report['checks']['masterDominantHz']=inspect()['dominantHz']
        assert abs(inspect()['dominantHz']-220)<30
        volume=driver.find_element(By.ID,'volume')
        for _ in range(10): volume.send_keys(Keys.ARROW_LEFT)
        wait.until(lambda d:inspect()['rms']<.012)
        report['checks']['nativeVolumeChangedThroughUI']=float(volume.get_attribute('value'))
        assert abs(float(volume.get_attribute('value'))-.1)<.001
        for _ in range(10): volume.send_keys(Keys.ARROW_RIGHT)
        pause(); wait.until(lambda d:inspect()['rms']<.00001)
        report['checks']['pausedRms']=inspect()['rms']
        anchor=inspect()['state']['periodStarted'];seek(1234.5)
        assert inspect()['state']['periodStarted']==anchor
        report['checks']['seekDoesNotAdvancePeriod']=True
        click('advance');time.sleep(.4)
        assert inspect()['state']['role']=='master' and inspect()['paused']
        report['checks']['duePauseRespected']=True
        click('resume');playing('request')
        snapshot=inspect(); suspended=snapshot['state']['masterPosition']
        assert abs(suspended-1234.5)<.1
        pins={a['id']:a['pinned'] for a in api('status')['assets']}
        assert pins[prepared['fixture:master']['id']] and pins[prepared['fixture:request']['id']]
        expect_http_conflict('delete',{'id':prepared['fixture:master']['id']})
        report['checks']['suspendedMasterPinned']=True
        wait.until(lambda d:inspect()['rms']>.01)
        report['checks']['requestAudioAnalysisRms']=inspect()['rms']
        report['checks']['requestDominantHz']=inspect()['dominantHz']
        assert abs(inspect()['dominantHz']-660)<30
        playing('master')
        wait.until(lambda d:inspect()['currentTime']>suspended+.1)
        first=inspect();report['measurements']+=first['measurements']
        assert first['state']['requestId'] is None
        assert first['state']['offsetMs']==900000
        assert len([e for e in first['events'] if e['type']=='request-ended'])==1
        report['checks']['oneRequestEndedAndMasterResumed']=True
        report['checks']['freshPeriodAfterRequest']=0 <= (time.time()*1000+first['state']['offsetMs']-first['state']['periodStarted'])<2000
        pause()
        # A second (AAC) request survives refresh without restoring master early.
        choose('request','fixture:aac');click('offer');click('advance');time.sleep(.3)
        assert inspect()['paused'];click('resume');playing('request')
        wait.until(lambda d:inspect()['currentTime']>1.2)
        pause(); saved_request=inspect()['currentTime'];saved_master=inspect()['state']['masterPosition']
        report['measurements']+=inspect()['measurements'][len(first['measurements']):]
        driver.refresh();wait.until(lambda d:d.execute_script('return !!window.proof?.inspect().state'))
        restored=inspect()
        assert restored['paused'] and not restored['owned'] and restored['state']['role']=='request'
        assert abs(restored['state']['position']-saved_request)<.35
        # pagehide release is best effort; lease is bounded at 10 seconds otherwise.
        expiry=api('status')['player']['expires']
        if expiry>time.time(): time.sleep(min(10.1,expiry-time.time()+.1))
        click('activate');playing('request')
        assert inspect()['currentTime']>=saved_request-.35
        playing('master');assert abs(inspect()['state']['masterPosition']-saved_master)<1
        report['measurements']+=inspect()['measurements']
        report['checks']['refreshDuringRequestRecovered']=True
        # A second fresh document cannot claim or start audio while this one owns it.
        main_handle=driver.current_window_handle
        driver.switch_to.new_window('tab');driver.get(base+'/display')
        wait.until(lambda d:d.execute_script('return !!window.proof?.inspect().state'))
        click('activate');wait.until(lambda d:'Another local proof tab' in driver.find_element(By.ID,'error').text)
        assert inspect()['paused'] and not inspect()['owned']
        report['checks']['secondTabRejected']=True
        driver.close();driver.switch_to.window(main_handle)
        # Refresh at master checkpoint recovers paused, with another explicit activation.
        pause();checkpoint_position=inspect()['currentTime'];driver.refresh()
        wait.until(lambda d:d.execute_script('return !!window.proof?.inspect().state'))
        assert not inspect()['owned'] and inspect()['paused']
        assert abs(inspect()['state']['position']-checkpoint_position)<.35
        report['checks']['masterRefreshRecovery']=True
        expiry=api('status')['player']['expires']
        if expiry>time.time(): time.sleep(min(10.1,expiry-time.time()+.1))
        click('activate');playing();reset()
        # At exactly six minutes, a due request waits for a real ended event.
        choose('master','fixture:song');choose('request','fixture:request');click('activate');playing()
        assert inspect()['duration']==360
        pause();seek(358.5);click('advance');click('resume');playing()
        time.sleep(.2);assert inspect()['state']['role']=='master'
        playing('request');playing('master')
        report['checks']['exactSixMinuteMasterFinishedBeforeRequest']=True
        reset()
        # Empty turns reset now; a later offer waits through the next period.
        choose('master','fixture:master');choose('request',None);click('activate');playing()
        pause();click('advance');wait.until(lambda d:any(e['type']=='empty-turn-reset' for e in inspect()['events']))
        assert inspect()['paused']
        report['checks']['emptyTurnResetWhilePaused']=True
        choose('request','fixture:request');click('offer');click('resume');playing();time.sleep(.4)
        assert inspect()['state']['role']=='master' and not inspect()['paused']
        report['checks']['lateRequestWaitsAfterEmptyTurn']=True
        # A prepared file becoming unavailable is a technical playback failure:
        # exactly two load attempts, return to pinned master, fresh period.
        if process:
            missing = data/'assets'/prepared['fixture:request']['id']/prepared['fixture:request']['file']
            held = missing.with_suffix('.held')
            missing.rename(held)
            try:
                click('advance')
                wait.until(lambda d:any(e['type']=='request-technical-failure' for e in inspect()['events']))
                playing('master')
                errors=[e for e in inspect()['events'] if e['type']=='load-failed']
                assert len(errors)==2 and inspect()['state']['requestId'] is None
                report['checks']['failedRequestRetriedTwiceThenReturnedToMaster']=True
            finally: held.rename(missing)
        # Synthetic browser fault injection, distinct from real playback evidence:
        # a forever-pending native-play substitute must not block controls forever.
        pause()
        driver.execute_script("document.getElementById('audio').play = () => new Promise(() => {})")
        click('resume')
        wait.until(lambda d:not inspect()['owned'] and inspect()['paused'] and 'Play timed out' in driver.find_element(By.ID,'error').text)
        driver.execute_script("delete document.getElementById('audio').play")
        report['checks']['syntheticPendingPlayIsBounded']=True
        click('activate');playing()
        # Service/network outage must stop local audio on failed heartbeat; durable checkpoint remains.
        if process:
            process.terminate();process.wait(timeout=10);process=None
            wait.until(lambda d:not inspect()['owned'] and inspect()['paused'])
            report['checks']['serviceLossStopsPlayback']=True
            report['lastStateOnServiceLoss']=inspect()['state']
        report['finalEvents']=inspect()['events']
        report['result']='passed'
        print(json.dumps({'result':report['result'],'browser':report['browser'],'checks':report['checks'],'measurements':report['measurements']},indent=2),flush=True)
    except Exception as exc:
        report['result']='failed';report['error']=repr(exc)
        if driver:
            try:
                report['failureState']=driver.execute_script('return window.proof?.inspect()')
                report['visibleError']=driver.find_element(By.ID,'error').text
            except Exception: pass
        raise
    finally:
        path=Path(args.output);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(report,indent=2)+'\n')
        if driver: driver.quit()
        if process:
            process.terminate();process.wait(timeout=10)
        if temporary: temporary.cleanup()


if __name__=='__main__': main()
