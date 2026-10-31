# Purdue Hackers Jukebox

Audio-only music queue and venue player for Hack Night. Phase 1 contains a
runnable local worker/cache and Firefox playback experiment. Phase 2 adds the
shared typed contract and a durable local queue/scheduler/device-authority
service. Production, a registered PH ID client, the real player, admin/attendee
pages, and the wall display remain later phases.
Intended production origin: `https://jukebox.purduehackers.com` (not deployed).

## Run the phase-2 queue service

Requires Node 22.18+ (tested on 26.11.1). Run `npm ci` once for type checking.

```sh
./scripts/run-service --dev-auth                  # offline: fake media, fixture metadata
./scripts/run-local &                             # phase-1 worker on :8971, then:
./scripts/run-service --dev-auth --worker http://127.0.0.1:8971
node scripts/smoke-service.ts                     # end-to-end smoke with owned fixtures
```

The service listens on `http://127.0.0.1:8980` (`--port`, `--data` for state).
`--dev-auth` is a clearly labelled local fake sign-in (`/auth/login` → form; tick
organizer for admin). PH ID uses `JUKEBOX_PHID_CLIENT_ID`, `JUKEBOX_PHID_REDIRECT_URI`,
`JUKEBOX_SESSION_SECRET` (and optional `JUKEBOX_PHID_CLIENT_SECRET`, `JUKEBOX_PHID_BASE`);
no Jukebox client is registered with PH ID yet, so live sign-in is untested.
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
link with the correct role. YouTube `si` share parameters are accepted and discarded. No cookies/accounts are used. Source access can fail;
there is no video or alternate-recording fallback. Requests must be under 360s.

The supplied master `https://youtu.be/TqTNaPB-4ow` and songs
`https://youtu.be/BXtL6W0RXpg` / `https://youtu.be/lPeJMoms_Ag` passed real-source
Firefox checks. Spotify remains a metadata/matching example, not playable media.

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
