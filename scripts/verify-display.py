#!/usr/bin/env python3
"""Phase 4C evidence: actual Firefox, automatic session player, real fixture audio.

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
        display = browser('/display')
        idle_began = time.monotonic()
        until(lambda: display.execute_script("return document.querySelector('main')?.dataset.state==='idle'"), 5)
        report['measurements']['idleAfterNavigationMs'] = round((time.monotonic()-idle_began)*1000, 2)
        assert 'admin needs to start a session' in display.find_element(By.TAG_NAME, 'body').text.lower()
        assert not display.find_elements(By.CSS_SELECTOR, '.display-now, .display-request, .display-device')
        click(display, '#player-activate')
        until(lambda: not display.find_elements(By.ID, 'player-activate'))
        assert display.execute_script("return document.querySelector('audio').paused")
        screenshot(display, 'idle.png')
        report['checks']['idleBeforeSessionAndOneSoundPermission'] = True
        command(admin, 'night.open')
        master = command(admin, 'master.add', {'url': 'fixture:master'})['entryId']
        command(admin, 'request.submit', {'url': 'fixture:request'})
        until(lambda: all(x['status'] == 'ready' for x in http(app + '/api/v1/snapshot')['requests']), 90)
        # master readiness is reflected in public nextMaster.
        until(lambda: http(app + '/api/v1/snapshot')['nextMaster'], 90)
        report['browser'] = {k: display.capabilities.get(k) for k in ['browserName', 'browserVersion', 'moz:headless', 'platformName']}
        assert report['browser']['browserName'] == 'firefox'
        assert display.execute_script("return document.querySelectorAll('audio').length===1&&document.querySelectorAll('video').length===0")
        assert not display.find_elements(By.ID, 'player-activate'), 'sound permission should survive session start'
        report['checks']['sessionStartsMusicAutomaticallyWithoutPairing'] = True
        until(lambda: canvas(display)['bass'] > .1, 25)
        time.sleep(2)
        live = canvas(display)
        assert live['bad'] == 0 and live['on'] > 500
        report['measurements']['master'] = live
        report['checks']['realAudioDrivesBayerPurplePixels'] = True
        until(lambda: display.execute_script("return document.fonts.check('30px PixelHackers')&&document.fonts.check('30px PolySans')&&document.fonts.check('30px Inconsolata')"))
        # Remain playing beyond stale-heartbeat cutoff: revision-only SSE used to fail here.
        time.sleep(16)
        assert canvas(display)['state'] == 'playing', canvas(display)
        report['checks']['positionHeartbeatsRemainLiveBeyondLeasePeriod'] = True
        for width, height in [(1920, 1080), (1366, 768)]:
            display.set_window_size(width, height + display.execute_script('return outerHeight-innerHeight'))
            alignment = display.execute_script("""const a=document.querySelector('.display-now').getBoundingClientRect(),b=document.querySelector('.display-request').getBoundingClientRect(),q=document.querySelector('.display-qr').getBoundingClientRect(),art=document.querySelector('.display-artwork').getBoundingClientRect();return {strip:Math.abs(a.top-b.top),bottom:Math.abs(a.bottom-b.bottom),qrCenter:Math.abs((q.top+q.height/2)-(art.top+art.height/2)),overflow:document.documentElement.scrollWidth>innerWidth};""")
            assert alignment['strip'] <= 1 and alignment['bottom'] <= 1 and alignment['qrCenter'] <= 1 and not alignment['overflow'], alignment
            report['measurements'][f'alignment{width}'] = alignment
            screenshot(display, f'layout-{width}.png')
        display.set_window_size(1920, 1080 + display.execute_script('return outerHeight-innerHeight'))
        screenshot(display, 'master.png')
        report['checks']['qrAndTrackShareStripAndVerticalCenter'] = True
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
        until(lambda: display.find_element(By.CSS_SELECTOR, '.display-kind').text == 'Request Queue' and canvas(display)['treble'] > .01 and canvas(display)['bass'] < .01, 15)
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
        assert display.find_element(By.CSS_SELECTOR, '.display-kind').text == 'Request Queue'
        until(lambda: display.find_element(By.CSS_SELECTOR, '[data-testid=player]').get_attribute('data-generation'), 25)
        if display.find_elements(By.ID, 'player-activate'): click(display, '#player-activate')
        command(admin, 'playback.play')
        until(lambda: canvas(display)['treble'] > .001)
        report['checks']['refreshReconnectsAutomaticallyAndRespectsBrowserSoundPermission'] = True
        until(lambda: display.find_element(By.CSS_SELECTOR, '.display-kind').text == 'Master Queue', 20)
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
        command(admin, 'night.close')
        until(lambda: display.execute_script("return document.querySelector('main')?.dataset.state==='idle'"), 35)
        until(lambda: display.execute_script("return document.querySelector('audio').paused"), 5)
        assert not display.find_elements(By.CSS_SELECTOR, '.display-now, .display-request')
        command(admin, 'night.open')
        until(lambda: display.find_elements(By.CSS_SELECTOR, '[data-testid=visualizer]') and canvas(display)['bass'] > .01, 25)
        assert not display.find_elements(By.ID, 'player-activate')
        report['checks']['endClearsDisplayAndNextSessionStartsWithoutAnotherClick'] = True
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
        report['failurePages'] = []
        for driver in drivers:
            try: report['failurePages'].append(driver.execute_script("return {text:document.body.innerText,main:document.querySelector('main')?.outerHTML,html:document.body.innerHTML.slice(0,4000)}"))
            except Exception: pass
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
