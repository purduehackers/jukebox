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
