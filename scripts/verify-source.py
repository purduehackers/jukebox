#!/usr/bin/env python3
"""Opt-in real network acquisition + actual Firefox interrupt/resume proof.
Not part of routine automated tests. No personal profiles, cookies, or secrets.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support.ui import Select, WebDriverWait

ROOT=Path(__file__).resolve().parent.parent


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--master',default='https://www.youtube.com/watch?v=MEkaqZecpUQ')
    parser.add_argument('--request',default='https://www.youtube.com/watch?v=K4DyBUG242c')
    parser.add_argument('--output',default='.local/source-evidence.json')
    args=parser.parse_args()
    report={'atUTC':datetime.now(timezone.utc).isoformat(),'checks':{},'assets':[],
            'requestEndMethod':'After real playback, seek near request end and wait for native ended event',
            'hardware':'Headless Firefox on development Linux; HDMI/wall untested'}
    (ROOT/'.local').mkdir(exist_ok=True)
    driver=None
    with tempfile.TemporaryDirectory(prefix='source-',dir=ROOT/'.local') as tmp:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        base=f'http://127.0.0.1:{port}'
        process=subprocess.Popen([sys.executable,'-m','jukebox.server','--port',str(port),'--data',tmp],cwd=ROOT)
        def api(path,body=None):
            request=urllib.request.Request(base+'/api/'+path,data=json.dumps(body).encode() if body is not None else None,
                                           headers={'Content-Type':'application/json'} if body is not None else {})
            with urllib.request.urlopen(request,timeout=5) as response: return json.load(response)
        try:
            for _ in range(100):
                try: api('status');break
                except OSError: time.sleep(.1)
            for source,kind in [(args.master,'master'),(args.request,'request')]:
                job=api('prepare',{'source':source,'kind':kind});deadline=time.monotonic()+250
                while time.monotonic()<deadline:
                    status=api('status');j=next(j for j in status['jobs'] if j['id']==job['id'])
                    if j['status']=='failed': raise AssertionError(j['error'])
                    if j['status']=='ready':
                        item=next(a for a in status['assets'] if a['id']==job['id']);report['assets'].append(item);break
                    time.sleep(.2)
                else: raise AssertionError('Preparation exceeded local worker deadline')
                assert item['selection']['vcodec']=='none'
                assert len(item['streams'])==1 and item['streams'][0]['type']=='audio'
                assert item['mediaTransfers'] and all(t['vcodec']=='none' for t in item['mediaTransfers'])
                print(f"{source}: {item['duration']}s, {item['bytes']} bytes, {item['preparationSeconds']}s preparation",flush=True)
            master,request=report['assets']
            assert master['duration']>1260 and request['duration']<360
            options=Options();options.add_argument('-headless');options.binary_location='/usr/bin/firefox'
            driver=webdriver.Firefox(options=options);driver.set_window_size(1280,1000)
            report['browser']={k:driver.capabilities.get(k) for k in ['browserName','browserVersion','moz:buildID','moz:geckodriverVersion','moz:headless']}
            assert report['browser']['browserName']=='firefox'
            driver.get(base+'/display');wait=WebDriverWait(driver,20,poll_frequency=.05)
            wait.until(lambda d:d.execute_script('return !!window.proof?.inspect().state'))
            inspect=lambda:driver.execute_script('return window.proof.inspect()')
            click=lambda id:driver.find_element(By.ID,id).click()
            Select(driver.find_element(By.ID,'master')).select_by_value(master['id'])
            Select(driver.find_element(By.ID,'request')).select_by_value(request['id'])
            click('activate');wait.until(lambda d:inspect()['owned'] and not inspect()['paused'] and not inspect()['swapping'])
            wait.until(lambda d:inspect()['rms']>.001)
            report['checks']['masterRms']=inspect()['rms']
            click('pause');wait.until(lambda d:inspect()['paused'] and inspect()['state']['paused'])
            el=driver.find_element(By.ID,'seek');el.clear();el.send_keys('1234.5');click('seekButton')
            wait.until(lambda d:abs(inspect()['currentTime']-1234.5)<.35)
            click('advance');time.sleep(.25);assert inspect()['paused']
            click('resume');wait.until(lambda d:inspect()['state']['role']=='request' and not inspect()['paused'] and not inspect()['swapping'])
            wait.until(lambda d:inspect()['currentTime']>1 and inspect()['rms']>.001)
            report['checks']['requestRms']=inspect()['rms']
            during=inspect();saved=during['state']['masterPosition']
            assert abs(saved-1234.5)<.1
            assert all(a['pinned'] for a in api('status')['assets'])
            report['checks']['bothAssetsPinnedDuringInterruption']=True
            # No four-minute wait required to prove native end->resume; the fixture
            # suite separately lets its whole short request play without seeking.
            el=driver.find_element(By.ID,'seek');el.clear();el.send_keys(str(request['duration']-1));click('seekButton')
            wait.until(lambda d:inspect()['state']['role']=='master' and not inspect()['swapping'] and not inspect()['paused'])
            result=inspect();report['measurements']=result['measurements'];report['events']=result['events']
            resume=result['measurements'][-1];assert abs(resume['actual']-saved)<.35
            report['checks']['savedMasterPosition']=saved
            report['checks']['resumeSeekErrorSeconds']=abs(resume['actual']-saved)
            report['checks']['requestNativeEnded']=any(e['type']=='request-ended' for e in result['events'])
            assert result['state']['requestId'] is None
            # Request can be deleted after unpin; master stays until explicit clear.
            api('delete',{'id':request['id']})
            try: urllib.request.urlopen(base+request['url'])
            except urllib.error.HTTPError as e: assert e.code==404;e.close()
            else: raise AssertionError('Deleted media still reachable')
            click('reset');wait.until(lambda d:inspect()['state']['masterId'] is None and not inspect()['owned'])
            api('delete',{'id':master['id']})
            assert api('status')['assets']==[]
            report['checks']['unpinDeleteAnd404']=True
            # Separate observed real-source failure, bounded and unpublished.
            job=api('prepare',{'source':'https://www.youtube.com/watch?v=BaW_jenozKc','kind':'request'})
            deadline=time.monotonic()+250
            while time.monotonic()<deadline:
                failed=next(j for j in api('status')['jobs'] if j['id']==job['id'])
                if failed['status'] not in ('queued','preparing'): break
                time.sleep(.2)
            report['unavailableSourceAttempt']=failed
            assert failed['status']=='failed' and api('status')['assets']==[]
            assert not any((Path(tmp)/'work').iterdir())
            report['checks']['sourceFailureCleanedWithoutFallback']=True
            report['result']='passed';print(json.dumps(report['checks'],indent=2),flush=True)
        except Exception as exc:
            report['result']='failed';report['error']=repr(exc)
            if driver:
                try: report['failureState']=driver.execute_script('return window.proof?.inspect()')
                except Exception: pass
            raise
        finally:
            path=Path(args.output);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(report,indent=2)+'\n')
            if driver: driver.quit()
            process.terminate();process.wait(timeout=10)


if __name__=='__main__': main()
