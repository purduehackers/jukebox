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
        if token or body.get('type') == 'display.connect':
            headers['Cookie'] = '; '.join(c['name'] + '=' + c['value'] for c in driver.get_cookies())
        if origin: headers['Origin'] = origin
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(), headers=headers, method='POST')
        with (opener.open(req, timeout=5) if opener else urllib.request.urlopen(req, timeout=5)) as response: return json.load(response)

    def get_json(base, path, token=None, opener=None):
        headers = {'Authorization': 'Bearer ' + token} if token else {}
        if token: headers['Cookie'] = '; '.join(c['name'] + '=' + c['value'] for c in driver.get_cookies())
        req = urllib.request.Request(base + path, headers=headers)
        with (opener.open(req, timeout=5) if opener else urllib.request.urlopen(req, timeout=5)) as response:
            return json.load(response)

    try:
        import os
        app_port = free_ports(1)[0]
        svc = web = f'http://127.0.0.1:{app_port}'
        temporary = tempfile.TemporaryDirectory(prefix='admin-', dir=out.parent)
        data = Path(temporary.name)
        env = {k:v for k,v in os.environ.items() if not k.startswith('JUKEBOX_')}
        env.update(NODE_ENV='test', PORT=str(app_port), JUKEBOX_ORIGIN=web, JUKEBOX_DEV_AUTH='1', JUKEBOX_FIXTURE_MEDIA='1', JUKEBOX_SERVICE_DATA=str(data))
        service = subprocess.Popen(['bun', '--no-env-file', 'scripts/start-web.ts'], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        wait_url(web + '/healthz'); check('serversReady', {'astro': web})
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
        verify('unauthenticatedGate', 'Organizer sign-in' in driver.page_source and driver.find_element(By.CSS_SELECTOR, 'a[href^="/auth/login"]'))
        driver.find_element(By.CSS_SELECTOR, 'a[href^="/auth/login"]').click()
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
        driver.find_element(By.CSS_SELECTOR, 'a[href^="/auth/login"]').click()
        wait.until(lambda d: d.find_elements(By.NAME, 'sub'))
        sign_in('organizer1', True)
        wait.until(lambda d: d.find_elements(By.XPATH, "//h1[contains(.,'Jukebox')]"))
        check('organizerAccess', True)

        activity = driver.find_element(By.ID, 'adm-activity')
        verify('activityLogInitiallyHidden', not activity.is_displayed())
        toggle = driver.find_element(By.CSS_SELECTOR, '[aria-controls="adm-activity"]')
        toggle.click()
        verify('activityLogEmptyState', activity.is_displayed() and 'No actions yet.' in activity.text)
        log_styles = driver.execute_script("const e=document.querySelector('.adm-activity');const s=getComputedStyle(e);return {border:s.borderTopWidth,animation:s.animationName,transition:s.transitionDuration};")
        verify('plainLogWithoutAnimation', log_styles == {'border':'0px','animation':'none','transition':'0s'}, log_styles)
        verify('activityToggleLabel', toggle.text.casefold() == 'hide activity log' and toggle.get_attribute('aria-expanded') == 'true')
        toggle.click()

        def confirm(label, confirm_label):
            driver.find_element(By.XPATH, f"//button[normalize-space()='{label}']").click()
            driver.find_element(By.XPATH, f"//button[normalize-space()='{confirm_label}']").click()

        driver.find_element(By.XPATH, "//button[normalize-space()='Start night']").click()
        wait.until(lambda d: 'Night open' in d.find_element(By.ID, 'adm-night').text)
        check('nightOpened', True)
        verify('actionsDoNotOpenLog', not driver.find_element(By.ID, 'adm-activity').is_displayed())
        driver.find_element(By.CSS_SELECTOR, '[aria-controls="adm-activity"]').click()
        wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, '#adm-activity time'))
        check('timestampedActionLog', True)

        def add_master(source):
            field = driver.find_element(By.ID, 'adm-add-url')
            # Firefox's type=url rejects fixture: values during native form validation. Set React's
            # controlled value through the native setter/events, then submit via the visible Add button.
            driver.execute_script("const e=arguments[0],s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,arguments[1]);e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));", field, source)
            driver.find_element(By.XPATH, "//button[normalize-space()='Add to master']").click()

        add_master('fixture:master')
        wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, '[aria-label="Master items"] li'))
        add_master('https://open.spotify.com/track/1OAFmguvHB2OI2AMYXpmyG')
        wait.until(lambda d: 'Spotify' in d.find_element(By.CSS_SELECTOR, '[data-testid="add-error"]').text)
        verify('fixtureCatalogRejected', 'not implemented yet' in driver.find_element(By.CSS_SELECTOR, '[data-testid="add-error"]').text)
        add_master('https://www.youtube.com/playlist?list=PLabc')
        # The activity label already contains the URL, so wait for the rejection text itself.
        wait.until(lambda d: 'Playlists and albums cannot be imported yet' in d.find_element(By.CSS_SELECTOR, '[data-testid="add-error"]').text)
        playlist_error = driver.find_element(By.CSS_SELECTOR, '[data-testid="add-error"]').text
        evidence['checks']['playlistRejected'] = 'playlist' in playlist_error.lower()
        evidence['details']['playlistRejected'] = {'visibleError': playlist_error, 'recentAction': driver.find_element(By.CSS_SELECTOR, '[aria-label="Action log"]').text.splitlines()[:4]}

        wait.until(lambda d: any(row.get_attribute('data-status') == 'ready' for row in d.find_elements(By.CSS_SELECTOR, '[aria-label="Master items"] li')))

        connected = post(web, '/api/v1/commands', {'commandId': str(uuid.uuid4()), 'type': 'display.connect', 'payload': {'secret': uuid.uuid4().hex + uuid.uuid4().hex}}, origin=web)
        token = connected['result']['token']
        generation = connected['result']['generation']

        def report_player(status='playing', position=None):
            snapshot = get_json(web, '/api/v1/snapshot', token)
            desired = snapshot['desired']
            pos = desired['startPositionSec'] if position is None else position
            post(web, '/api/v1/commands', {'commandId': str(uuid.uuid4()), 'type': 'player.report', 'payload': {'generation': generation, 'epoch': desired['epoch'], 'loadId': desired['loadId'], 'status': status, 'positionSec': pos}}, token)
            return get_json(web, '/api/v1/snapshot', token)['desired']

        # Starting the session has already requested playback.
        report_player()
        wait.until(lambda d: 'playing' in d.find_element(By.CSS_SELECTOR, '[data-testid="player-state"]').text.lower())
        wait.until(lambda d: d.find_element(By.CSS_SELECTOR, '[data-testid="confirmation"]').get_attribute('data-confirmation') == 'confirmed')
        check('playConfirmed', True)

        # Hold a real command before the network call: local toggles must work while it waits.
        driver.execute_script("""
          const original = window.fetch.bind(window);
          window.__playbackHeld = true;
          window.fetch = async (...args) => {
            const body = args[1]?.body;
            if (typeof body === 'string' && JSON.parse(body).type === 'playback.pause' && window.__playbackHeld) {
              await new Promise(resolve => { window.__releasePlayback = () => { window.__playbackHeld = false; resolve(); }; });
            }
            return original(...args);
          };
        """)
        driver.find_element(By.CSS_SELECTOR, '.adm-play').click()
        wait.until(lambda d: d.find_element(By.CSS_SELECTOR, '.adm-play').text.casefold() == 'play')
        verify('pauseUiBeforeNetwork', get_json(web, '/api/v1/snapshot', token)['desired']['intent'] == 'playing')
        driver.find_element(By.CSS_SELECTOR, '.adm-play').click()
        verify('rapidPlayUiBeforeNetwork', driver.find_element(By.CSS_SELECTOR, '.adm-play').text.casefold() == 'pause')
        driver.execute_script('window.__releasePlayback()')
        wait.until(lambda d: not d.find_elements(By.CSS_SELECTOR, '[data-intent="playback.play"][data-status="pending"]'))
        verify('rapidToggleOrder', get_json(web, '/api/v1/snapshot', token)['desired']['intent'] == 'playing')
        report_player()
        seek_start = int(driver.find_element(By.ID, 'adm-seek').get_attribute('value'))
        driver.find_element(By.XPATH, "//button[@aria-label='Forward 15 seconds']").click()
        wait.until(lambda d: seek_start + 15 <= get_json(web, '/api/v1/snapshot', token)['desired']['startPositionSec'] < seek_start + 17)
        report_player()
        check('seekForward15', True)
        driver.execute_script("""
          const original = window.fetch.bind(window);
          window.fetch = async (...args) => {
            const body = args[1]?.body;
            if (typeof body === 'string' && JSON.parse(body).type === 'playback.volume') {
              await new Promise(resolve => { window.__releaseVolume = resolve; });
            }
            return original(...args);
          };
        """)
        volume = driver.find_element(By.ID, 'adm-volume')
        current = int(volume.get_attribute('value'))
        for _ in range(abs(current - 40)): volume.send_keys(Keys.ARROW_LEFT if current > 40 else Keys.ARROW_RIGHT)
        wait.until(lambda d: d.execute_script('return typeof window.__releaseVolume === "function"'))
        verify('volumeUiBeforeNetwork', volume.get_attribute('value') == '40' and abs(get_json(web, '/api/v1/snapshot', token)['desired']['volume'] - .4) > .005)
        time.sleep(2.1)  # Let the confirmed playback clock advance beyond its last report.
        seek_before_volume = int(driver.find_element(By.ID, 'adm-seek').get_attribute('value'))
        driver.execute_script('window.__releaseVolume()')
        wait.until(lambda d: abs(get_json(web, '/api/v1/snapshot', token)['desired']['volume'] - .4) < .005)
        wait.until(lambda d: d.find_element(By.CSS_SELECTOR, '[data-testid="confirmation"]').get_attribute('data-confirmation') == 'requested')
        seek_after_volume = int(driver.find_element(By.ID, 'adm-seek').get_attribute('value'))
        verify('volumeDoesNotRewindSeek', seek_after_volume >= seek_before_volume, {'before': seek_before_volume, 'after': seek_after_volume})
        check('volume40Percent', True)
        verify('volumeUiStaysAt40', volume.get_attribute('value') == '40')
        verify('volumeDoesNotClutterActivity', not driver.find_elements(By.CSS_SELECTOR, '.adm-activity [data-intent="playback.volume"]'))
        report_player()
        driver.set_window_size(1366, 1000)
        layout = driver.execute_script("""
          const row = [...document.querySelector('.adm-add-row').children].map(e => { const r=e.getBoundingClientRect();return {top:r.top,height:r.height}; });
          return {row, headings:[...document.querySelectorAll('h2')].map(e=>e.textContent)};
        """)
        verify('linkRowAligned', len({r['top'] for r in layout['row']}) == 1 and len({r['height'] for r in layout['row']}) == 1, layout)
        verify('clearSectionHeadings', all(h in layout['headings'] for h in ['Now playing', 'Queue', 'Master queue', 'Requests queue']), layout)
        log_layout = driver.execute_script("""
          const log=document.querySelector('#adm-activity').getBoundingClientRect();
          const queues=document.querySelector('.adm-queues').getBoundingClientRect();
          const end=document.querySelector('.adm-night button').getBoundingClientRect();
          const toggle=document.querySelector('[aria-controls="adm-activity"]').getBoundingClientRect();
          return {belowQueues:log.top>=queues.bottom,buttonBesideEndNight:toggle.left>=end.right && Math.abs(toggle.top-end.top)<1};
        """)
        verify('logBelowQueuesAndToggleBesideEndNight', all(log_layout.values()), log_layout)
        driver.find_element(By.CSS_SELECTOR, '[aria-controls="adm-activity"]').click()
        verify('activityLogCanBeHidden', not driver.find_element(By.ID, 'adm-activity').is_displayed())
        driver.save_screenshot(str(out.parent / 'admin-desktop.png'))

        # Keep reporting the old epoch: the display is online but has not applied the new change.
        old_desired = report_player()
        driver.find_element(By.CSS_SELECTOR, '.adm-play').click()
        wait.until(lambda d: get_json(web, '/api/v1/snapshot', token)['desired']['intent'] == 'paused')
        wait.until(lambda d: d.find_element(By.CSS_SELECTOR, '[data-testid="confirmation"]').get_attribute('data-confirmation') == 'requested')
        player_height = driver.find_element(By.CSS_SELECTOR, '.adm-player').rect['height']
        verify('normalUpdateIsQuiet', not driver.find_element(By.CSS_SELECTOR, '.adm-display-wait').is_displayed() and 'Sending to display' not in driver.find_element(By.TAG_NAME, 'body').text)
        for index in range(4):
            time.sleep(4)
            post(web, '/api/v1/commands', {'commandId': str(uuid.uuid4()), 'type': 'player.report', 'payload': {'generation': generation, 'epoch': old_desired['epoch'], 'loadId': old_desired['loadId'], 'status': 'playing', 'positionSec': old_desired['startPositionSec']}}, token)
            if index < 3:
                verify(f'noSpinnerBefore15Seconds_{index}', not driver.find_element(By.CSS_SELECTOR, '.adm-display-wait').is_displayed())
        wait.until(lambda d: d.find_element(By.CSS_SELECTOR, '.adm-display-wait').is_displayed())
        verify('delayedSpinnerWithoutLayoutShift', abs(driver.find_element(By.CSS_SELECTOR, '.adm-player').rect['height'] - player_height) < 1)
        verify('noDuplicateUnconfirmedBanner', not driver.find_elements(By.CSS_SELECTOR, '[data-alert="unconfirmed_command"]'))
        report_player('paused')
        wait.until(lambda d: not d.find_element(By.CSS_SELECTOR, '.adm-display-wait').is_displayed())
        check('spinnerClearsOnAcknowledgement', True)
        driver.find_element(By.CSS_SELECTOR, '.adm-play').click()
        wait.until(lambda d: get_json(web, '/api/v1/snapshot', token)['desired']['intent'] == 'playing')
        report_player()
        driver.find_element(By.XPATH, "//button[@aria-label='Restart song']").click()
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
        wait.until(lambda d: any('bob' in li.text and li.get_attribute('data-status') == 'ready' for li in d.find_elements(By.CSS_SELECTOR, 'section[aria-labelledby="adm-requests"] li')))
        check('requestFromBobVisible', True)

        # ---- Queue controls (mode, interval, Play now). Every effect is read back from the service. ----
        held = {}

        def snapshot_now(): return get_json(web, '/api/v1/snapshot', token)

        def ack(status='playing', position=None):
            desired = snapshot_now()['desired']
            held.update(epoch=desired['epoch'], loadId=desired['loadId'], position=desired['startPositionSec'] if position is None else position)
            return report_player(status, position)

        def hold():
            # While requests-only is silent there is no desired load: keep the lease with the held load's heartbeat.
            post(web, '/api/v1/commands', {'commandId': str(uuid.uuid4()), 'type': 'player.report', 'payload': {'generation': generation, 'epoch': held['epoch'], 'loadId': held['loadId'], 'status': 'paused', 'positionSec': held['position']}}, token)

        def radio(mode): return driver.find_element(By.CSS_SELECTOR, f'[role="radio"][data-mode="{mode}"]')

        def set_interval_field(value):
            field = driver.find_element(By.ID, 'adm-interval')
            driver.execute_script("const e=arguments[0],s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;s.call(e,arguments[1]);e.dispatchEvent(new Event('input',{bubbles:true}));", field, str(value))

        def set_button(): return driver.find_element(By.XPATH, "//form[contains(@class,'adm-interval')]//button[normalize-space()='Set']")

        def request_row(who): return next(li for li in driver.find_elements(By.CSS_SELECTOR, 'section[aria-labelledby="adm-requests"] li') if who in li.text)

        ack()
        verify('modeDefaultsToAuto', radio('auto').get_attribute('aria-checked') == 'true' and snapshot_now()['schedule']['mode'] == 'auto')
        verify('threeModeChoices', [r.text.casefold() for r in driver.find_elements(By.CSS_SELECTOR, '[role="radiogroup"] [role="radio"]')] == ['auto', 'master only', 'requests only'])
        set_interval_field(0)
        verify('intervalRejectsInvalidInput', 'Use a whole number from 1 to 120' in driver.find_element(By.ID, 'adm-queue-control').text and not set_button().is_enabled())
        set_interval_field(20)
        set_button().click()
        wait.until(lambda d: snapshot_now()['schedule']['periodMs'] == 20 * 60_000)
        ack()
        driver.refresh()  # the setting is service state, not browser state
        wait.until(lambda d: d.find_elements(By.ID, 'adm-interval'))
        wait.until(lambda d: d.find_element(By.ID, 'adm-interval').get_attribute('value') == '20')
        check('intervalPersistsAcrossReload', True)
        set_interval_field(15)
        set_button().click()
        wait.until(lambda d: snapshot_now()['schedule']['periodMs'] == 15 * 60_000)
        check('intervalSetAndReset', {'saved': '20 min', 'reset': '15 min'})
        ack()

        # Play now: bob's ready request interrupts the master mix immediately.
        master_before = snapshot_now()['nowPlaying']['title']
        row = request_row('bob')
        row.find_element(By.XPATH, ".//button[normalize-space()='Play now…']").click()
        verify('playNowNamesTheInterruption', f'Interrupts “{master_before}”' in row.text, row.text)
        row.find_element(By.XPATH, ".//button[normalize-space()='Play now']").click()
        wait.until(lambda d: snapshot_now()['schedule']['phase'] == 'request')
        ack()
        wait.until(lambda d: 'request' in d.find_element(By.CSS_SELECTOR, '.adm-kind').text.lower())
        verify('playNowStartsRequest', snapshot_now()['nowPlaying']['kind'] == 'request' and 'resumes at' in driver.find_element(By.CSS_SELECTOR, '.adm-track-text').text)
        wait.until(lambda d: any(b.get_attribute('title') for b in d.find_elements(By.XPATH, "//button[normalize-space()='Play now…']")) or not d.find_elements(By.XPATH, "//button[normalize-space()='Play now…']"))
        ack('ended', 30)
        wait.until(lambda d: snapshot_now()['schedule']['phase'] == 'master')
        ack()
        check('requestEndsMasterResumes', snapshot_now()['nowPlaying']['title'])

        # Requests only: confirm, cut in, chain, wait silently, then leave.
        post(web, '/api/v1/commands', {'commandId': str(uuid.uuid4()), 'type': 'request.submit', 'payload': {'url': 'fixture:request'}}, origin=web, opener=opener)
        wait.until(lambda d: any(li.get_attribute('data-status') == 'ready' for li in d.find_elements(By.CSS_SELECTOR, 'section[aria-labelledby="adm-requests"] li')))
        radio('requests').click()
        confirm_group = driver.find_element(By.CSS_SELECTOR, '[aria-label="Confirm: Requests only"]')
        verify('requestsOnlyAsksFirst', 'Interrupts' in confirm_group.text and snapshot_now()['schedule']['mode'] == 'auto', confirm_group.text)
        driver.find_element(By.XPATH, "//button[normalize-space()='Cancel']").click()
        verify('requestsOnlyCancelChangesNothing', snapshot_now()['schedule']['mode'] == 'auto')
        radio('requests').click()
        driver.find_element(By.XPATH, "//button[normalize-space()='Switch to Requests only']").click()
        wait.until(lambda d: snapshot_now()['schedule']['mode'] == 'requests' and snapshot_now()['schedule']['phase'] == 'request')
        ack()
        wait.until(lambda d: radio('requests').get_attribute('aria-checked') == 'true')
        ack('ended', 30)
        wait.until(lambda d: snapshot_now()['schedule']['requestsIdle'])
        verify('requestsOnlyWaitsSilently', snapshot_now()['desired'] is None)
        wait.until(lambda d: 'waiting for requests' in d.find_element(By.ID, 'adm-turn').text.casefold())
        verify('idleShowsWaitingForRequests', 'Waiting for requests' in driver.find_element(By.CSS_SELECTOR, '.adm-track-text').text and 'resumes at' in driver.find_element(By.CSS_SELECTOR, '.adm-track-text').text)
        driver.save_screenshot(str(out.parent / 'admin-requests-idle.png'))
        for _ in range(3): hold(); time.sleep(1)
        radio('master').click()
        wait.until(lambda d: snapshot_now()['schedule']['mode'] == 'master' and snapshot_now()['nowPlaying'] is not None)
        ack()
        verify('masterOnlyTurnLine', 'master only' in driver.find_element(By.ID, 'adm-turn').text.casefold() and snapshot_now()['schedule']['periodStartedAt'] is None)
        radio('auto').click()
        wait.until(lambda d: snapshot_now()['schedule']['mode'] == 'auto' and snapshot_now()['schedule']['periodStartedAt'] is not None)
        ack()
        check('modeRoundTrip', 'auto -> requests -> idle -> master -> auto')
        driver.save_screenshot(str(out.parent / 'admin-queue-controls.png'))
        report_player()  # fresh report so the lease-expiry check below starts now

        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if 'reconnecting' in driver.find_element(By.CSS_SELECTOR, '[data-testid="player-state"]').text.lower(): break
            time.sleep(.5)
        verify('displayReportsStale', 'reconnecting' in driver.find_element(By.CSS_SELECTOR, '[data-testid="player-state"]').text.lower())
        verify('offlineAlert', driver.find_elements(By.CSS_SELECTOR, '[data-alert="player_offline"]'))

        # Firefox will not open a window narrower than 500 CSS px, so measure inside a real 390 px same-origin
        # iframe: its layout viewport (media queries, overflow) is exactly a phone's. Same session cookie.
        driver.execute_script("const f=document.createElement('iframe');f.id='phone';f.style.cssText='position:fixed;left:0;top:0;width:390px;height:844px;border:0;z-index:9999;background:#171717';f.src='/admin';document.body.appendChild(f)")
        driver.switch_to.frame('phone')
        wait.until(lambda d: d.find_elements(By.ID, 'adm-night'))
        time.sleep(1)
        metrics = driver.execute_script('''
          const visible=e=>!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);
          const buttons=[...document.querySelectorAll('button')].filter(b=>visible(b)&&b.innerText.trim()).map(b=>({text:b.innerText.trim(),height:b.getBoundingClientRect().height}));
          const p=document.querySelector('.adm-root'),cs=getComputedStyle(p),body=getComputedStyle(document.body);
          return {scrollWidth:document.documentElement.scrollWidth,innerWidth:innerWidth,buttons,
            panelBackground:cs.backgroundColor,panelBorder:cs.borderTopColor,panelBorderWidth:cs.borderTopWidth,bodyBackground:body.backgroundColor};
        ''')
        driver.switch_to.default_content()
        driver.save_screenshot(str(out.parent / 'admin-mobile.png'))
        driver.switch_to.frame('phone')
        driver.execute_script("document.getElementById('adm-queue-control').scrollIntoView({block: 'center'})")
        time.sleep(.3)
        driver.switch_to.default_content()
        driver.save_screenshot(str(out.parent / 'admin-mobile-controls.png'))
        check('mobileScreenshot', str(out.parent / 'admin-mobile.png'))
        offenders = [b for b in metrics['buttons'] if b['height'] < 40]
        evidence['details']['mobileLayoutMetrics'] = metrics
        evidence['checks']['mobileViewport390'] = metrics['innerWidth'] == 390
        evidence['details']['mobileViewport390'] = metrics
        evidence['checks']['noHorizontalOverflow'] = metrics['innerWidth'] == 390 and metrics['scrollWidth'] <= metrics['innerWidth']
        evidence['details']['noHorizontalOverflow'] = metrics
        verify('mobileButtonHeights', not offenders, {'offenders': offenders, 'allButtons': metrics['buttons']})
        verify('officialDarkAdminRoot', metrics['panelBackground'] == 'rgb(0, 0, 0)', metrics)

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
