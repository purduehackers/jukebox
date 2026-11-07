# Purdue Hackers Jukebox

Audio-only music queue and venue player for Hack Night. Phase 1 contains a
runnable local worker/cache and Firefox playback experiment. Phase 2 adds the
shared typed contract and a durable local queue/scheduler/device-authority
service. The local app includes the native Firefox player, admin controls, attendee requests,
and an audio-reactive display. Live local PH ID sign-in has been verified;
production deployment and physical venue checks remain pending.
Intended production origin: `https://jukebox.purduehackers.com` (not deployed).

Current behavior and remaining release gates: [implementation and deployment status](docs/jukebox/CURRENT-STATUS.md) (reviewed 2026-11-06).

New chat: [current handoff](docs/jukebox/NEXT-CHAT.md).

## Run the complete local app

For real PH ID sign-in, copy `.env.example` to `.env.local` and fill it in once;
startup loads it automatically on every run. See [PH ID setup](docs/jukebox/PH-ID-SETUP.md).
The file stays private and is ignored by Git.

```sh
./scripts/run-dev --data .local/display-demo/service
```

Real audio is the default: the script reuses the local worker on :8971 or starts
one with isolated worker state at `.local/dev-worker`. An existing app on
:5173/:8980 is left running and startup fails clearly. To manage the worker
separately, run `./scripts/run-local --data .local/display-demo/worker`, then
`./scripts/run-dev --worker http://127.0.0.1:8971 --data .local/display-demo/service`.
See [link compatibility and live-source evidence](docs/jukebox/LINK-COMPATIBILITY.md)
for supported URLs, catalog behavior, configuration, and isolated test ports.

Open **http://127.0.0.1:5173/display in Firefox** and sign in with an organizer PH ID account.
The display and visualizer lab require organizer access; attendees cannot open them. If Firefox blocks autoplay, set
this site's Autoplay permission to **Allow Audio and Video** in the address bar
once; there is no app sound-enable button. Open **http://127.0.0.1:5173/admin**,
sign in with PH ID, add master music, and click **Start night**. The display stays
connected, starts music automatically, and resumes near its checkpoint on reload.
**End night** stops audio and shows **Night not started**. No pairing, linking,
exclusive display lock, or 15-second startup wait. Two display tabs can both play.
`/queue` is the silent attendee request page.

The example reuses saved display-demo service state and the local worker cache. All services bind to
loopback. Without PH ID configuration, the development script uses labelled fake
sign-in. To use the registered PH ID client, follow [PH ID setup](docs/jukebox/PH-ID-SETUP.md).

The consolidated baseline is `main`. Start new work from the latest `origin/main`;
older phase branches may omit recent fixes. The existing local PH ID checkout can
still run the app with its private `.env.local` and saved state. The visualizer tuning lab is
`/visual` (use instead of `/display` while tuning audio). It saves sliders locally
and offers Copy settings and an underlying-function view. `/visual?silent=1` is a
silent layout check. `/display` uses the approved stationary soundbar preset from
`docs/jukebox/references/soundbar-approved-settings.json`; lab changes do not alter it.
A closed night deliberately shows the empty session screen;
start a night in `/admin` to show music and the visualizer. See the
[connection audit](docs/jukebox/PLAYER-CONNECTION-AUDIT.md) for the simplified flow.

## Operator deployment

See [the deployment guide](docs/jukebox/DEPLOYMENT.md) for production startup,
server storage, environment variables, HTTPS/SPA/SSE ingress and systemd examples.
The production launcher requires explicit persistent data directories and never
loads local developer credentials. QR and request links follow the deployed site
origin, so `https://jukebox.purduehackers.com` produces the matching `/queue` URL.

## Run the phase-2 queue service

Requires Node 22.18+ (tested on 26.11.1). Run `npm ci` once for type checking.

```sh
./scripts/run-service --dev-auth --fixture-media  # explicit offline fixtures, no audio
./scripts/run-local &                             # phase-1 worker on :8971, then:
./scripts/run-service --dev-auth --worker http://127.0.0.1:8971
node scripts/smoke-service.ts                     # end-to-end smoke with owned fixtures
```

The service listens on `http://127.0.0.1:8980` (`--port`, `--data` for state).
`--dev-auth` is a clearly labelled local fake sign-in (`/auth/login` → form; tick
organizer for admin). PH ID uses `JUKEBOX_PHID_CLIENT_ID`, `JUKEBOX_PHID_REDIRECT_URI`,
`JUKEBOX_SESSION_SECRET` (and optional `JUKEBOX_PHID_CLIENT_SECRET`, `JUKEBOX_PHID_BASE`);
live local PH ID sign-in was verified on 2026-11-02; production remains unconfigured.
API: `GET /api/v1/snapshot`, `GET /api/v1/stream` (SSE), `POST /api/v1/commands`,
`GET /media/<id>` (same-origin proxy to the worker). Contract, behavior table,
and limits: [Phase-2 contract](docs/jukebox/PHASE-2-CONTRACT.md).

## Run the local proof

Requires Linux, Python 3.11+, FFmpeg/ffprobe, Node 22+, and Firefox. On CachyOS/Arch,
install missing system dependencies as the normal user with
`yay -S --needed python ffmpeg nodejs firefox`. This uses official-repository
packages; no system packages or global configuration were changed for this proof.

```sh
./scripts/run-local
```

This creates a local Python virtual environment and installs the pinned worker
dependency on first use. Open **http://127.0.0.1:8971/display in Firefox**.
Use `--port 8972` if occupied, or `--data .local/another-proof` for separate state.
The service binds to loopback only. Stop it with Ctrl+C.

1. Prepare `fixture:master` as **Master** (one hour; generation takes about 30–35s
   on the development machine). Prepare `fixture:request` as **Request** (4s).
2. Select those assets in the playback section. Click **Activate / Resume this
   tab**. This is an explicit local proof lease; opening a page stays silent.
3. Pause, seek to `1234.5`, then advance the test clock by 15 minutes. It stays
   paused. Click **Resume**: one request plays to its end, then master resumes
   from the actual saved position. The elapsed-period anchor is independent of seek.
4. Observe RMS/frequency from actual audio, checkpoint acknowledgements, and pins.
   Refresh: audio stays silent until activation; checkpoint/asset references persist.
5. **Clear proof checkpoint** releases the references. Delete unused assets with
   their Delete buttons. Selected/active/suspended assets reject deletion server-side.

`fixture:song` is exactly 360 seconds of AAC for the normal-song boundary;
`fixture:aac` is an 8-second AAC request. Fixture generation creates audio only.
To try the real adapter, enter one HTTPS YouTube `/watch?v=…` or `youtu.be/…`
link with the correct role. Single-video watch/share/mobile/Music/Shorts/archived-live links accept common sharing, timestamp and radio/list context, then discard it. True playlist-only links remain unsupported. Full recording duration is enforced, starting at position zero. No cookies/accounts are used. Source access can fail;
there is no video or alternate-recording fallback. Requests must be under 360s.

The supplied master `https://youtu.be/TqTNaPB-4ow` and songs
`https://youtu.be/BXtL6W0RXpg` / `https://youtu.be/lPeJMoms_Ag` passed real-source
Firefox checks. Spotify and Apple track metadata now match to bounded YouTube audio-only candidates; see the link compatibility report for live verification and limits.

Preparation finishes before playback; this is a seekable completed-file cache,
not a growing-file stream. It retains supported audio codecs (Opus/Vorbis, AAC,
MP3, FLAC); Firefox verification here covers Opus/WebM and AAC/M4A only.

## Verify

```sh
.venv/bin/python -m pip install -r requirements-dev.lock.txt
npm ci
./scripts/check   # Python worker, phase-1 policy, tsc, and phase-2 TypeScript tests
.venv/bin/python scripts/verify-firefox.py
# Opt-in network test; downloads real audio and then deletes the test assets:
.venv/bin/python scripts/verify-source.py
```

The Firefox scripts launch `/usr/bin/firefox` using a fresh temporary profile and
Selenium Manager/geckodriver. The first run may download geckodriver. They do not
read personal browser profiles or change autoplay preferences. The fixture script
starts its own isolated server/data directory, generates owned synthetic audio,
and writes `.local/firefox-evidence.json`. `--headed` runs it visibly. The source
script writes `.local/source-evidence.json`; it is separate from routine checks.
Neither script demonstrates audible HDMI output. A Chromium preview is useful
for reading this lab page, but is not Firefox evidence.

Measured results, source URLs, limits, recovery semantics, interface proposals,
and remaining venue/server checks: [Phase-1 findings](docs/jukebox/PHASE-1-FINDINGS.md).
Original authority: [approved plan](docs/jukebox/APPROVAL-PLAN.md),
[decision log](docs/jukebox/DECISIONS.md), [phase brief](docs/jukebox/phases/01-playback.md).
The dashboard checkout was not modified. The lab uses diagnostic controls and
brand color tokens; final fonts/shader/layout belong to the later display phase.
