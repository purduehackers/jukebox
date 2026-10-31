#!/usr/bin/env python3
"""Phase 4C evidence: actual Firefox, paired phase-3 player, real fixture audio.

Uses isolated loopback service/worker and disposable Firefox profiles. No provider
traffic, credentials, autoplay overrides, or production state. Screenshots and
measurements are written under .local/. HDMI and phone scanning remain venue gates.
"""
from datetime import datetime, timezone
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
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
import importlib.util
spec = importlib.util.spec_from_file_location('player_verify', Path(__file__).with_name('verify-player.py'))
helpers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helpers)
until, http, port = helpers.until, helpers.http, helpers.port
ROOT = Path(__file__).resolve().parent.parent


def main():
    output = ROOT / '.local/display-evidence'
    output.mkdir(parents=True, exist_ok=True)
    report = {'atUTC': datetime.now(timezone.utc).isoformat(), 'checks': {}, 'measurements': {},
              'hardware': 'Headless Linux; HDMI, viewing distance, wall and phone scan pending',
              'autoplayPreferencesOverridden': False}
    children, drivers, logs = [], [], []
    temp = tempfile.TemporaryDirectory(prefix='jukebox-display-')
    work = Path(temp.name)
    wp, sp, ap = port(), port(), port()
    worker, service, app = f'http://127.0.0.1:{wp}', f'http://127.0.0.1:{sp}', f'http://127.0.0.1:{ap}'

    def start(argv, env=None):
        log = open(work / f'{len(logs)}.log', 'w+')
        logs.append(log)
        process = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        children.append(process)

    def browser(path, reduced=False):
        options = Options()
        options.add_argument('-headless')
        options.binary_location = '/usr/bin/firefox'
        if reduced: options.set_preference('ui.prefersReducedMotion', 1)
        driver = webdriver.Firefox(options=options)
        drivers.append(driver)
        driver.set_window_size(1920, 1200)
        chrome_height = driver.execute_script('return outerHeight-innerHeight')
        driver.set_window_size(1920, 1080 + chrome_height)
        driver.get(app + path)
        return driver

    def click(driver, selector):
        until(lambda: driver.find_elements(By.CSS_SELECTOR, selector) and driver.find_element(By.CSS_SELECTOR, selector).is_enabled())
        driver.find_element(By.CSS_SELECTOR, selector).click()

    def command(driver, kind, payload=None):
        result = driver.execute_async_script('''
          const done=arguments[arguments.length-1];
          fetch('/api/v1/commands',{method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({commandId:arguments[0],type:arguments[1],payload:arguments[2]})})
            .then(r=>r.json()).then(done,e=>done({error:String(e)}));
        ''', str(uuid.uuid4()), kind, payload or {})
        assert result.get('ok'), (kind, result)
        return result['result']

    def screenshot(driver, name):
        driver.execute_async_script("document.fonts.ready.then(()=>requestAnimationFrame(()=>requestAnimationFrame(arguments[0])))")
        time.sleep(.3)
        driver.save_screenshot(str(output / name))

    def canvas(driver):
        return driver.execute_script('''const c=document.querySelector('[data-testid=visualizer]');
          const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
          let on=0,bad=0;for(let i=0;i<pixels.length;i+=4){if(pixels[i]===126&&pixels[i+1]===60&&pixels[i+2]===255)on++;else if(pixels[i]||pixels[i+1]||pixels[i+2])bad++;}
          return {bass:Number(c.dataset.bass||0),treble:Number(c.dataset.treble||0),on,bad,width:c.width,height:c.height,
            message:document.querySelector('.display-signal').textContent,state:document.querySelector('[data-testid=display]').dataset.state};''')

    try:
        start([sys.executable, '-m', 'jukebox.server', '--port', str(wp), '--data', str(work / 'worker')])
        until(lambda: http(worker + '/api/status'), 30)
        start(['node', 'scripts/player-fixture-server.ts', '--port', str(sp), '--worker', worker,
               '--data', str(work / 'service'), '--origin', app])
        start([str(ROOT / 'node_modules/.bin/vite'), '--port', str(ap), '--strictPort'], {**os.environ, 'JUKEBOX_SERVICE': service})
        until(lambda: http(service + '/healthz'), 30)
        until(lambda: urllib.request.urlopen(app + '/display', timeout=2).status == 200, 30)
        admin = browser('/auth/login?returnTo=/admin')
        until(lambda: admin.find_elements(By.NAME, 'sub'))
        admin.find_element(By.NAME, 'sub').send_keys('display_organizer')
        admin.find_element(By.NAME, 'roles').click()
        admin.find_element(By.TAG_NAME, 'button').click()
        until(lambda: '/admin' in admin.current_url)
        command(admin, 'night.open')
        master = command(admin, 'master.add', {'url': 'fixture:master'})['entryId']
        command(admin, 'request.submit', {'url': 'fixture:request'})
        until(lambda: all(x['status'] == 'ready' for x in http(app + '/api/v1/snapshot')['requests']), 90)
        # master readiness is reflected in public nextMaster.
        until(lambda: http(app + '/api/v1/snapshot')['nextMaster'], 90)
        code = command(admin, 'device.pairing.create', {'name': 'Display verifier'})['code']
        display = browser('/display')
        report['browser'] = {k: display.capabilities.get(k) for k in ['browserName', 'browserVersion', 'moz:headless', 'platformName']}
        assert report['browser']['browserName'] == 'firefox'
        assert display.execute_script("return document.querySelectorAll('audio').length===1&&document.querySelectorAll('video').length===0&&document.querySelector('audio').paused")
        report['checks']['oneSilentAudioElementNoVideo'] = True
        click(display, '.display-device summary')
        display.find_element(By.ID, 'player-code').send_keys(code)
        click(display, '#player-pair'); click(display, '#player-claim')
        until(lambda: display.find_element(By.ID, 'player-activate').is_enabled())
        command(admin, 'playback.play')
        until(lambda: display.find_element(By.CSS_SELECTOR, '[data-testid=player]').get_attribute('data-load-id'))
        click(display, '#player-activate')
        until(lambda: canvas(display)['bass'] > .1, 25)
        time.sleep(2)
        live = canvas(display)
        assert live['bad'] == 0 and live['on'] > 500
        report['measurements']['master'] = live
        report['checks']['realAudioDrivesBayerPurplePixels'] = True
        click(display, '.display-device summary')
        until(lambda: display.execute_script("return document.fonts.check('30px PixelHackers')&&document.fonts.check('30px PolySans')&&document.fonts.check('30px Inconsolata')"))
        # Remain playing beyond stale-heartbeat cutoff: revision-only SSE used to fail here.
        time.sleep(16)
        assert canvas(display)['state'] == 'playing', canvas(display)
        report['checks']['positionHeartbeatsRemainLiveBeyondLeasePeriod'] = True
        screenshot(display, 'master.png')
        command(admin, 'playback.pause')
        until(lambda: canvas(display)['state'] == 'paused' and canvas(display)['bass'] == 0)
        paused = canvas(display)
        assert paused['treble'] == 0 and paused['on'] < live['on']
        report['measurements']['paused'] = paused
        report['checks']['pauseClearsToFlatLine'] = True
        before = display.find_element(By.CSS_SELECTOR, '.display-turn strong').text
        time.sleep(1.2)
        after = display.find_element(By.CSS_SELECTOR, '.display-turn strong').text
        assert before != after
        report['checks']['countdownContinuesWhilePaused'] = True
        command(admin, 'playback.seek', {'entryId': master, 'positionSec': 1234.5})
        until(lambda: abs(display.execute_script("return document.querySelector('audio').currentTime") - 1234.5) < .1)
        command(admin, 'playback.play')
        until(lambda: canvas(display)['bass'] > .01)
        report['checks']['seekResumesRealAnalysis'] = True
        http(service + '/__test/due', {})
        until(lambda: display.find_element(By.CSS_SELECTOR, '.display-kind').text == 'REQUEST' and canvas(display)['treble'] > .01 and canvas(display)['bass'] < .01, 15)
        request = canvas(display)
        report['measurements']['request'] = request
        assert request['bass'] < live['bass'] / 2
        assert request['treble'] > live['treble']
        report['checks']['masterRequestSwitchChangesMeasuredFrequencyBands'] = True
        screenshot(display, 'request.png')
        command(admin, 'playback.pause')
        until(lambda: display.execute_script("return document.querySelector('audio').paused"))
        display.refresh()
        until(lambda: display.find_elements(By.CSS_SELECTOR, '.display-kind'))
        assert display.execute_script("return document.querySelector('audio').paused")
        assert display.find_element(By.CSS_SELECTOR, '.display-kind').text == 'REQUEST'
        click(display, '.display-device summary')
        # Old document release is best effort. Respect the production 15 s lease.
        time.sleep(15.2)
        click(display, '#player-claim'); click(display, '#player-activate')
        command(admin, 'playback.play')
        until(lambda: canvas(display)['treble'] > .001)
        report['checks']['refreshRecoversSharedTrackAndRequiresExplicitActivation'] = True
        until(lambda: display.find_element(By.CSS_SELECTOR, '.display-kind').text == 'MASTER · MIX', 20)
        until(lambda: canvas(display)['bass'] > .01)
        assert display.execute_script("return document.querySelector('audio').currentTime") > 1234
        report['checks']['suspendedMasterResumesAndAnalysisFollows'] = True
        # Actual QR matrix decode, using a browser-reachable test origin. Phone scan pending.
        qr = display.find_element(By.CSS_SELECTOR, '.display-qr')
        qr.screenshot(str(output / 'qr.png'))
        import zxingcpp
        from PIL import Image
        decoded = zxingcpp.read_barcode(Image.open(output / 'qr.png'))
        assert decoded and decoded.text == app + '/queue', decoded
        report['checks']['qrDecodesToReachableTestQueue'] = True
        report['measurements']['qrTarget'] = decoded.text
        fixture = browser('/display?displayFixture=long_titles')
        until(lambda: fixture.find_elements(By.CSS_SELECTOR, '.display-fixture-control'))
        for state in ['long_titles', 'many_requests', 'empty', 'closed', 'paused', 'buffering', 'offline', 'needs_activation', 'due_song', 'due_paused', 'disconnected']:
            fixture.get(app + '/display?displayFixture=' + state)
            until(lambda: fixture.find_elements(By.CSS_SELECTOR, '.display-fixture-control'))
            assert fixture.execute_script('return document.documentElement.scrollWidth<=innerWidth')
            assert fixture.execute_script("return document.querySelectorAll('audio,video').length===0")
            screenshot(fixture, state + '.png')
        report['checks']['fixtureStatesAndLongTitlesNoHorizontalOverflow'] = True
        reduced = browser('/display?displayFixture=master', reduced=True)
        until(lambda: 'reduced motion' in reduced.find_element(By.CSS_SELECTOR, '.display-signal').text.lower())
        assert reduced.execute_script("return matchMedia('(prefers-reduced-motion: reduce)').matches")
        report['checks']['reducedMotionPreferenceHonored'] = True
        report['result'] = 'passed'
    except Exception as error:
        report['result'] = 'failed'
        report['error'] = repr(error)
        for i, driver in enumerate(drivers):
            try: driver.save_screenshot(str(output / f'failure-{i}.png'))
            except Exception: pass
        raise
    finally:
        (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
        for driver in drivers:
            try: driver.quit()
            except Exception: pass
        for process in reversed(children):
            try: os.killpg(process.pid, signal.SIGTERM); process.wait(timeout=5)
            except Exception:
                try: os.killpg(process.pid, signal.SIGKILL)
                except Exception: pass
        if report.get('result') != 'passed':
            for i, log in enumerate(logs):
                log.flush(); log.seek(0)
                (output / f'process-{i}.log').write_text(log.read())
        for log in logs: log.close()
        temp.cleanup()
        print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
