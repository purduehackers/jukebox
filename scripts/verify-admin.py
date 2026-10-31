#!/usr/bin/env python3
"""Run a real Firefox end-to-end check of the organizer page on isolated local servers."""
import argparse
from datetime import datetime, timezone
import http.cookiejar
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import traceback
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parent.parent


def free_ports(count=2):
    sockets, ports = [], []
    try:
        for _ in range(count):
            sock = socket.socket(); sock.bind(('127.0.0.1', 0)); sockets.append(sock)
            ports.append(sock.getsockname()[1])
    finally:
        for sock in sockets: sock.close()
    if len(set(ports)) != count: return free_ports(count)
    return ports


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', default='.local/admin-evidence.json')
    parser.add_argument('--headed', action='store_true')
    args = parser.parse_args()
    out = Path(args.output); out = out if out.is_absolute() else ROOT / out
    out.parent.mkdir(parents=True, exist_ok=True)
    evidence = {'atUTC': datetime.now(timezone.utc).isoformat(), 'checks': {}, 'details': {}, 'headless': not args.headed}
    service = vite = driver = temporary = None
    started = time.monotonic()

    def check(name, detail=True):
        evidence['checks'][name] = True; evidence['details'][name] = detail

    def verify(name, condition, detail=''):
        if not condition: raise AssertionError(f'{name}: {detail or "condition was false"}')
        check(name, detail or True)

    def wait_url(url):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(url, timeout=1) as response:
                    if response.status == 200: return
            except (OSError, urllib.error.URLError): pass
            time.sleep(.15)
        raise AssertionError(f'Server did not become ready: {url}')

    def post(base, path, body, token=None, origin=None, opener=None):
        headers = {'Content-Type': 'application/json'}
        if token: headers['Authorization'] = 'Bearer ' + token
        if origin: headers['Origin'] = origin
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers=headers, method='POST')
        with (opener.open(req, timeout=5) if opener else urllib.request.urlopen(req, timeout=5)) as response: return json.load(response)

    def get_json(base, path, token=None, opener=None):
        headers = {'Authorization': 'Bearer ' + token} if token else {}
        req = urllib.request.Request(base + path, headers=headers)
        with (opener.open(req, timeout=5) if opener else urllib.request.urlopen(req, timeout=5)) as response:
            return json.load(response)

    try:
        svc_port, vite_port = free_ports()
        svc = f'http://127.0.0.1:{svc_port}'; web = f'http://127.0.0.1:{vite_port}'
        temporary = tempfile.TemporaryDirectory(prefix='admin-', dir=out.parent)
        data = Path(temporary.name) / 'data'; data.mkdir()
        env = dict(__import__('os').environ, JUKEBOX_ORIGIN=web)
        service = subprocess.Popen(['node', 'src/server/main.ts', '--dev-auth', '--port', str(svc_port), '--data', str(data)], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        vite = subprocess.Popen(['node_modules/.bin/vite', '--port', str(vite_port), '--strictPort'], cwd=ROOT, env=dict(env, JUKEBOX_SERVICE=svc), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_url(web + '/healthz'); check('serversReady', {'vite': web, 'service': svc})

        options = Options()
        if not args.headed:
            options.add_argument('-headless')
            options.add_argument('--width=500')
            options.add_argument('--height=1100')
        options.binary_location = '/usr/bin/firefox'
        driver = webdriver.Firefox(options=options)
        driver.set_script_timeout(15)
        wait = WebDriverWait(driver, 20, poll_frequency=.1)
        driver.get(web + '/admin')
        wait.until(lambda d: 'Organizer sign-in' in d.page_source)
        verify('unauthenticatedGate', 'Organizer sign-in' in driver.page_source and driver.find_element(By.LINK_TEXT, 'Sign in'))
        driver.find_element(By.LINK_TEXT, 'Sign in').click()
        wait.until(lambda d: d.find_elements(By.NAME, 'sub'))
        verify('fakeSignInForm', driver.find_element(By.NAME, 'sub') and driver.find_elements(By.CSS_SELECTOR, 'input[name="roles"][value="organizer"]') and driver.find_element(By.XPATH, "//button[normalize-space()='Sign in']"))

        def sign_in(sub, organizer):
            field = driver.find_element(By.NAME, 'sub'); field.clear(); field.send_keys(sub)
            box = driver.find_element(By.CSS_SELECTOR, 'input[name="roles"][value="organizer"]')
            if box.is_selected() != organizer: box.click()
            driver.find_element(By.XPATH, "//button[normalize-space()='Sign in']").click()

        sign_in('alice', False)
        wait.until(lambda d: 'Organizer access required' in d.page_source)
        check('nonOrganizerForbidden', True)
        driver.find_element(By.LINK_TEXT, 'Use a different account').click()
        wait.until(lambda d: d.find_elements(By.NAME, 'sub'))
        sign_in('organizer1', True)
        wait.until(lambda d: d.find_elements(By.XPATH, "//h1[contains(.,'Jukebox')]"))
        check('organizerAccess', True)

        def confirm(label, confirm_label):
            driver.find_element(By.XPATH, f"//button[normalize-space()='{label}']").click()
            driver.find_element(By.XPATH, f"//button[normalize-space()='{confirm_label}']").click()

        confirm('Open night…', 'Open night')
        wait.until(lambda d: 'Requests are accepted' in d.find_element(By.ID, 'adm-night').find_element(By.XPATH, '../..').text)
        check('nightOpened', True)

        def add_master(source):
            field = driver.find_element(By.ID, 'adm-add-url')
            # Firefox's type=url rejects fixture: values during native form validation. Set React's
            # controlled value through the native setter/events, then submit via the visible Add button.
            driver.execute_script("const e=arguments[0],s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,arguments[1]);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));", field, source)
            driver.find_element(By.XPATH, "//button[normalize-space()='Add']").click()

        add_master('fixture:master')
        wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, '[aria-label="Master items"] li'))
        add_master('https://open.spotify.com/track/1OAFmguvHB2OI2AMYXpmyG')
        wait.until(lambda d: 'Spotify' in d.find_element(By.CSS_SELECTOR, '[data-testid="add-error"]').text)
        verify('spotifyRejected', 'cannot be played yet' in driver.find_element(By.CSS_SELECTOR, '[data-testid="add-error"]').text)
        add_master('https://www.youtube.com/playlist?list=PLabc')
        # The activity label already contains the URL, so wait for the rejection text itself.
        wait.until(lambda d: 'Playlists and albums cannot be imported yet' in d.find_element(By.CSS_SELECTOR, '[data-testid="add-error"]').text)
        playlist_error = driver.find_element(By.CSS_SELECTOR, '[data-testid="add-error"]').text
        evidence['checks']['playlistRejected'] = 'playlist' in playlist_error.lower()
        evidence['details']['playlistRejected'] = {'visibleError': playlist_error, 'recentAction': driver.find_element(By.CSS_SELECTOR, '[aria-label="Recent actions"]').text.splitlines()[:4]}

        wait.until(lambda d: any('ready' in row.text.lower() for row in d.find_elements(By.CSS_SELECTOR, '[aria-label="Master items"] li')))

        driver.find_element(By.XPATH, "//button[normalize-space()='New pairing code']").click()
        wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, '[data-testid="pairing-code"]'))
        code = driver.find_element(By.CSS_SELECTOR, '[data-testid="pairing-code"]').text.strip()
        paired = post(web, '/api/v1/commands', {'commandId': str(uuid.uuid4()), 'type': 'device.pair', 'payload': {'code': code}}, origin=web)
        token = paired['result']['token']
        claimed = post(web, '/api/v1/commands', {'commandId': str(uuid.uuid4()), 'type': 'player.claim', 'payload': {}}, token)
        generation = claimed['result']['generation']

        def report_player(status='playing', position=None):
            snapshot = get_json(web, '/api/v1/snapshot', token)
            desired = snapshot['desired']
            pos = desired['startPositionSec'] if position is None else position
            post(web, '/api/v1/commands', {'commandId': str(uuid.uuid4()), 'type': 'player.report', 'payload': {'generation': generation, 'epoch': desired['epoch'], 'loadId': desired['loadId'], 'status': status, 'positionSec': pos}}, token)
            return get_json(web, '/api/v1/snapshot', token)['desired']

        driver.find_element(By.XPATH, "//button[normalize-space()='Play']").click()
        report_player()
        wait.until(lambda d: 'playing' in d.find_element(By.CSS_SELECTOR, '[data-testid="player-state"]').text.lower())
        wait.until(lambda d: 'confirmed by display' in d.find_element(By.CSS_SELECTOR, '[data-testid="confirmation"]').text.lower())
        check('playConfirmed', True)
        driver.find_element(By.XPATH, "//button[normalize-space()='+15 s']").click()
        wait.until(lambda d: abs(report_player(position=15)['startPositionSec'] - 15) < .1)
        check('seekTo15', True)
        volume = driver.find_element(By.ID, 'adm-volume')
        current = int(volume.get_attribute('value'))
        for _ in range(abs(current - 40)): volume.send_keys(Keys.ARROW_LEFT if current > 40 else Keys.ARROW_RIGHT)
        wait.until(lambda d: abs(get_json(web, '/api/v1/snapshot', token)['desired']['volume'] - .4) < .005)
        check('volume40Percent', True)
        driver.find_element(By.XPATH, "//button[normalize-space()='Replay']").click()
        wait.until(lambda d: abs(get_json(web, '/api/v1/snapshot', token)['desired']['startPositionSec']) < .1)
        check('replayFromZero', True)

        rows = driver.find_elements(By.CSS_SELECTOR, '[aria-label="Master items"] li')
        before = [r.get_attribute('data-entry') for r in rows]
        add_master('fixture:song')
        wait.until(lambda d: len(d.find_elements(By.CSS_SELECTOR, '[aria-label="Master items"] li')) == len(before) + 1)
        rows = driver.find_elements(By.CSS_SELECTOR, '[aria-label="Master items"] li')
        second = rows[-1]; second.find_element(By.CSS_SELECTOR, '[aria-label="Move up"]').click()
        wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, '[aria-label="Master items"] li')[0].get_attribute('data-entry') != before[0])
        check('masterReordered', True)
        rows = driver.find_elements(By.CSS_SELECTOR, '[aria-label="Master items"] li')
        row = next(r for r in rows if r.get_attribute('data-entry') == before[-1])
        row.find_element(By.XPATH, ".//button[normalize-space()='Remove…']").click()
        row.find_element(By.XPATH, ".//button[normalize-space()='Remove']").click()
        wait.until(lambda d: not d.find_elements(By.CSS_SELECTOR, f'[aria-label="Master items"] li[data-entry="{before[-1]}"]'))
        check('masterRemoved', True)
        report_player()  # Start the lease-expiry check from a fresh acknowledged report.

        jar = http.cookiejar.CookieJar(); opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        login = urllib.request.Request(web + '/auth/login?returnTo=/queue')
        with opener.open(login, timeout=5) as response: location = response.geturl()
        state = urllib.parse.parse_qs(urllib.parse.urlparse(location).query)['state'][0]
        with opener.open(web + '/auth/callback?state=' + urllib.parse.quote(state) + '&sub=bob', timeout=5) as response: pass
        post(web, '/api/v1/commands', {'commandId': str(uuid.uuid4()), 'type': 'request.submit', 'payload': {'url': 'fixture:request'}}, origin=web, opener=opener)
        wait.until(lambda d: any('bob' in li.text and 'ready' in li.text.lower() for li in d.find_elements(By.CSS_SELECTOR, 'section[aria-labelledby="adm-requests"] li')))
        check('requestFromBobVisible', True)

        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if 'offline' in driver.find_element(By.CSS_SELECTOR, '[data-testid="player-state"]').text.lower(): break
            time.sleep(.5)
        verify('displayOffline', 'offline' in driver.find_element(By.CSS_SELECTOR, '[data-testid="player-state"]').text.lower())
        verify('offlineAlert', driver.find_elements(By.CSS_SELECTOR, '[data-alert="player_offline"]'))

        # Firefox will not open a window narrower than 500 CSS px, so measure inside a real 390 px same-origin
        # iframe: its layout viewport (media queries, overflow) is exactly a phone's. Same session cookie.
        driver.execute_script("const f=document.createElement('iframe');f.id='phone';f.style.cssText='position:fixed;left:0;top:0;width:390px;height:844px;border:0;z-index:9999;background:#171717';f.src='/admin';document.body.appendChild(f)")
        driver.switch_to.frame('phone')
        wait.until(lambda d: 'Night session' in d.page_source)
        time.sleep(1)
        metrics = driver.execute_script('''
          const visible=e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);
          const buttons=[...document.querySelectorAll('button')].filter(b=>visible(b)&&b.innerText.trim()).map(b=>({text:b.innerText.trim(),height:b.getBoundingClientRect().height}));
          const p=document.querySelector('.jb-panel'),cs=getComputedStyle(p),body=getComputedStyle(document.body);
          return {scrollWidth:document.documentElement.scrollWidth,innerWidth:innerWidth,buttons,
            panelBackground:cs.backgroundColor,panelBorder:cs.borderTopColor,panelBorderWidth:cs.borderTopWidth,bodyBackground:body.backgroundColor};
        ''')
        driver.switch_to.default_content()
        driver.save_screenshot(str(out.parent / 'admin-mobile.png'))
        check('mobileScreenshot', str(out.parent / 'admin-mobile.png'))
        offenders = [b for b in metrics['buttons'] if b['height'] < 40]
        evidence['details']['mobileLayoutMetrics'] = metrics
        evidence['checks']['mobileViewport390'] = metrics['innerWidth'] == 390
        evidence['details']['mobileViewport390'] = metrics
        evidence['checks']['noHorizontalOverflow'] = metrics['innerWidth'] == 390 and metrics['scrollWidth'] <= metrics['innerWidth']
        evidence['details']['noHorizontalOverflow'] = metrics
        verify('mobileButtonHeights', not offenders, {'offenders': offenders, 'allButtons': metrics['buttons']})
        verify('panelAndBodyColors', metrics['panelBackground'] == 'rgb(0, 0, 0)' and metrics['panelBorder'] == 'rgb(126, 60, 255)' and metrics['panelBorderWidth'] == '1px' and metrics['bodyBackground'] == 'rgb(23, 23, 23)', metrics)

        driver.delete_cookie('jb_session')
        wait.until(lambda d: 'Session expired' in d.page_source)
        check('sessionExpiredGate', True)
    except Exception as error:
        evidence['error'] = f'{type(error).__name__}: {error}'
        evidence['traceback'] = traceback.format_exc()
        if driver:
            try: evidence['pageText'] = driver.find_element(By.TAG_NAME, 'body').text
            except Exception: pass
    finally:
        if driver:
            try: driver.quit()
            except Exception: pass
        for process in (vite, service):
            if process and process.poll() is None:
                process.terminate()
                try: process.wait(timeout=8)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
        if temporary: temporary.cleanup()
        evidence['runtimeSeconds'] = round(time.monotonic() - started, 2)
        out.write_text(json.dumps(evidence, indent=2) + '\n')
        for name, passed in evidence['checks'].items(): print(f"{'PASS' if passed else 'FAIL'} {name}: {evidence['details'].get(name, '')}")
        if evidence.get('error'): print('FAIL run:', evidence['error'])
        print(f"Evidence: {out} ({evidence['runtimeSeconds']}s)")
    return 1 if evidence.get('error') or not all(evidence['checks'].values()) else 0


if __name__ == '__main__':
    raise SystemExit(main())
