# Phase 4C: dedicated display

Implemented locally on `feat/jukebox-display`, based on the app shell `c2dc883` and
incorporating the committed phase-3 player through `cbdb3b0`. No production deploy.

## Confirmed component decisions (2026-10-30)

The user selected visualizer **A: scrolling envelope** after viewing A/B/C mockups;
real thumbnails; requests plus next master track; the attached **PolySans Slim,
PolySans Slim Italic, PixelHackers** fonts; **1920×1080**; and **Lunar separate**.
The mockup's composition is retained: large left visualization, bottom now-playing
strip, right queue/countdown and request QR. Real artwork is an ordinary still
image, with an explicit missing/error placeholder. No generated substitute cover.

## Implementation choices

- Client rendering consumes the phase-3 player's existing `AnalyserNode` via
  `shared/audio-tap.ts`. Display never creates audio elements, contexts, mic input,
  or a second audio source. `Player` is mounted exactly once, in a collapsible
  device setup panel. Pair, claim, and local activation remain deliberate actions.
- Canvas 2D renders black `#000000` and purple `#7e3cff`, using the same 4×4 Bayer
  thresholds and two CSS pixel cells as the reference. The selected envelope
  replaces the proposed warp geometry; no idle shader is mixed in. Reference
  speed 0.04 / scale 1 are warp parameters, not imposed on the audio history.
- Bass is integrated frequency energy from 30–250 Hz, lower ridge 250–10,000 Hz.
  FFT configuration stays owned by the player (2048). Fixed gain (12), attack
  60 ms / release 280 ms; time-domain RMS <0.001 gates silence. These are current
  tuning choices, not a claim of beat tracking or calibrated loudness.
- Ten seconds of measured history scroll right to left with rendering targeted
  at 30 fps; history is resampled by elapsed time, so slower frames do not stretch
  it. Pause/buffering/unavailable local analysis show a flat center line. Silence
  decays and scrolls old history off. Track/analyser changes reset history;
  discontinuous observed seek positions clear it. No made-up audio response.
- Reduced-motion preference uses a stationary pair of current-energy ridges at
  5 updates/second instead of scrolling. Canvas failures and absent/suspended
  analysis are visible. A remote read-only display cannot visualize audio from
  another device and says it is waiting for local audio.
- Server time plus monotonic elapsed client time drives countdown and progress.
  The service alone resets the timer, changes turns, and decides empty turns.
  Pauses/buffering count; seek does not move the period. Due states explain song
  end, pause or offline waits. Unconfirmed sources do not show guessed progress.
- Only ready/preparing requests are listed; requester identity is never rendered.
  Four visible rows plus an overflow count. The service's privacy-safe next master
  is separate from requests; suspended mixes are labelled as resuming.
- QR is encoded locally with an intact four-module quiet zone. Configure
  `VITE_JUKEBOX_PUBLIC_ORIGIN=https://jukebox.purduehackers.com` at build time;
  otherwise it uses the current page origin, always `/queue`. Invalid origins
  produce a visible error. Loopback preview shows a phone-reachability reminder.
- Self-hosted Inconsolata body font; supplied PixelHackers headings and PolySans
  metadata. Exact dashboard surface/token and one-pixel purple border treatment.
  No changes to the dashboard or Lunar repos.

The existing server remains relevant to audio preparation/cache and authoritative
state. Browser-local analysis avoids sending PCM over the network and keeps the
visualization tied to actual local audio. No server-generated video, hosting
purchase, provisioning, or claim about the unverified server's specs is needed.

## Local review and verification

- `./scripts/check`: worker, policy, service, metadata/privacy, display model/signal
  and SSE tests; TypeScript; production build. See final report for counts.
- `.venv/bin/python scripts/verify-display.py`: isolated real worker/service,
  disposable Firefox profiles, real phase-3 pairing/activation, pixel/band samples,
  pause, elapsed countdown, seek, master/request/resume, refresh and QR decode.
  Install optional decoder dependencies with
  `.venv/bin/pip install -r scripts/requirements-display.txt`.
  Evidence is written to `.local/display-evidence/report.json` and screenshots.
- Dev-only snapshot review: `/display?displayFixture=long_titles`; selector covers
  master/request, pause, buffering, offline, activation, empty/closed, due states,
  disconnect, very long text, and thirty pending requests. Fixture view mounts no
  player, carries a visible dev label, and is eliminated from production builds.

## Shared proposals and limitations

See [metadata + SSE proposals](proposals/phase-4c.md) and
[assets/dependencies](proposals/phase-4c-assets.md). Integration owner review is
required when combining parallel phase branches, especially SQLite migrations.
Artwork is optional for older records and source adapters without thumbnails;
actual provider thumbnails were not fetched in automated verification.

Pending venue checks: physical dimensions/viewing distance, actual Firefox GPU/CPU
load on the laptop, HDMI routing and audible output, phone scanning a QR using an
approved reachable origin, sleep/wake and prolonged whole-night rehearsal. Layout
is targeted at 1920×1080, not a claim of wall testing. No public dev service was
exposed, and no DNS/auth/deployment work occurred.

## Recorded result

On 2026-10-30, `./scripts/check` passed: 15 Python tests, five policy tests,
43 TypeScript tests, both TypeScript projects and the production build.
`verify-display.py` passed in Firefox 158.0.1 at an exact 1920×1080 viewport:
real audio/Bayer pixel response, position heartbeats beyond 15 seconds, pause,
elapsed paused countdown, seek, master→request→resumed master, explicit activation
after refresh, QR decoding to the browser-reachable test `/queue`, all listed
fixture states without horizontal overflow, and reduced-motion preference.
`verify-player.py --dev-smoke` also passed against the actual run-dev path.
Screenshot capture waits for fonts and completed paint; long-title and queue
screenshots were visually inspected. Fixture history is flat when no local player
exists, intentionally. No claim of phone scanning or real venue audio is made.

One bounded Codex Other / gpt-6-luna medium subagent delivered the metadata proposal
(`7992857`, cherry-picked as `b346dee`) with passing tests and typecheck. Lead review
added optional-field compatibility, URL credential rejection and migration upgrade
coverage; independently found and fixed the revision-only SSE freshness gap.
Design, rendering, player integration and Firefox review stayed with the lead.
No additional top-level threads or later phases were started.

## Session-driven display update (2026-11-01)

The user's revised flow replaces the manual pairing/claim panel with automatic
background connection and an **Enable sound** prompt only when browser autoplay
policy requires it. No session shows an empty “An admin needs to start a session”
screen. Session start plays the ready master (or waits for preparation); end
stops sound and clears presentation. The same document keeps its sound activation
across sessions. Single-player leases, actual acknowledgement, native audio and
real analysis are retained behind the scenes. Admin no longer shows pairing UI.

Also removed by the user: mix-pause caption, next-master panel and loopback phone
notice. QR and now-playing share the same grid row. QR dimensions match artwork:
166px at 1920×1080, 130px in the compact laptop layout. Sidebar text scales with it.

Verification on 2026-11-01: `./scripts/check` passed 15 Python worker tests,
5 scheduling-policy tests, 98 TypeScript tests, both typechecks and the app build.
`verify-display.py` passed 15 checks in Firefox 158.0.1 with unchanged autoplay
preferences, including sound permission before session start, automatic start,
stop/blank/restart, refresh, real analysis, QR decode and exact strip/QR centering
at 1920×1080 and 1366×768. The idle state appeared 61ms after navigation in that run.
The shared snapshot client now fetches initial state immediately and reconciles
via a five-second poll alongside SSE, so session state recovers after an event
stream stalls during a backend restart.

`verify-player.py` then passed all 11 session/player checks, including competing
displays, paused mid-request refresh without double charging, bounded technical
failure/refund, backend restart and automatic recovery without another click.
`verify-admin.py` passed 23 UI checks, including direct session start, silent
remote controls, expired sign-in and a 390px mobile viewport. These are isolated
Firefox tests; no claim of audible HDMI/venue hardware testing is made.

## Unified waveform/flow rendering (2026-11-01)

The user clarified that wisps should extend the waveform with matching weight,
wide roots and thin tips; a separate *processing step* must not look like a second
layer. They also identified bounce/thickness misalignment and requested simpler,
faster code. The old smoke feedback buffer attached to the unbounced outline;
repeated resampling softened it into a halo.

The renderer now computes the measured envelope and its drift/bounce first,
adds tapered curved extensions to that finished geometry, then applies one
material and Bayer dithering. Roots inherit the finished edge's position; the
bounce displacement falls off cubically toward independently morphing tips.
Positive `wispSweep` goes right. There is no accumulated smoke, additive material,
or final blur stack. Large buffers are reused. Flow geometry uses half-resolution
distance samples; the band, final material and Bayer pattern use full resolution.

The tuner replaces the old emit/advection/blend controls with `wispLength`,
`wispWidth`, `wispTaper`, `wispSweep`, `wispCurl`, `wispSpacing`, `wispSpeed`, and
`edgeSoftness`. Old URL keys for removed settings are ignored. `dither:0` still
shows the underlying material. Reload `/display?tune` without an old `viz` query
for the new defaults. The interior now shares one density/texture with the plumes,
so roots no longer add a bright patch over the band.

Verification: eight signal/display tests and the app typecheck pass. The isolated
Firefox display workflow passed with real fixture audio; this does not establish
venue/HDMI behavior. A regression checks that flow cannot brighten the fully
filled interior or erase band pixels through bounce, and that silence clears it.

Final headless Firefox 158 synthetic geometry benchmark at 667×388 render cells:
60 warmed samples, 22 ms median / 31 ms p95 with dithering enabled. These are
local render timings, not a whole-night or physical display frame-rate guarantee.
