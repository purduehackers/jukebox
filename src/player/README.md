# Automatic Firefox display

`/display` owns one native audio element and a Web Audio analyser. It connects on
page load and keeps the same connection across nights. No night shows **Night not
started** with no audio. Starting a night starts the ready master, or waits for
preparation; ending a night cancels pending media operations and stops audio before
the idle screen is rendered. Admin and attendee pages remain silent.

The native player and presentation consume one ordered snapshot subscription.
SSE supplies immediate updates, with polling and post-report snapshots for recovery.
`display.connect` provides page-scoped report credentials even while the night is
closed. Automatic displays have no exclusive lease, claim, takeover, expiry
watchdog or startup delay. Two tabs can both play. Legacy paired-device APIs remain
for compatibility with existing service fixtures; the app does not use them.

Playback is attempted automatically. There is no app **Enable sound** button or
activation prerequisite. Firefox can still block native audio/Web Audio. Set the
site's persistent Autoplay permission to **Allow Audio and Video** in Firefox's
address bar. The app retries automatically and only explains the browser setting
if playback is actually blocked. Reloads and subsequent nights use the same saved
site permission. The app cannot grant or bypass a browser permission.

Reports save actual positions and acknowledge applied commands. Reloads resume near
the durable checkpoint; explicit seeks take precedence over old reports. Media
load/seek/play work is serialized, cancellable, and bounded. Superseded operations
cannot start an old song or count as a technical failure. Real media errors retain
bounded retries and quota refunds. The suspended master asset remains pinned.

A control-server outage does not stop buffered audio after an arbitrary timeout.
On reconnection the display follows current server state and reports its actual
position. A disconnected browser cannot receive an End night command until it
reconnects; an open display tab and the laptop's audio output remain necessary.
The server cannot produce HDMI audio on behalf of a closed browser.

Verify with `./scripts/check`, `.venv/bin/python scripts/verify-player.py`,
`.venv/bin/python scripts/verify-display.py`, and
`.venv/bin/python scripts/verify-queue-controls.py`. These use isolated service
state, real synthetic audio assets and disposable Firefox profiles. The player test
checks Firefox's default block, then saves a site permission once and exercises
reloads and multiple nights without app clicks. No global autoplay preference is
changed. Output goes to an isolated null audio sink. Physical HDMI remains a venue
check.
