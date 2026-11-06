# Current implementation and deployment readiness

Updated 2026-11-06 (America/Indiana/Indianapolis). This is the current-state
companion to the original approved plan, not a new product approval request.
Later user decisions in DECISIONS.md supersede the original plan where they differ.

## Baseline and local startup

Original scan baseline: `32c265a` (approved stationary soundbar), present on
`origin/main` and `feat/jukebox-visualizer-next` at review time. The local `main`
branch was still at `5f526b4`; update it before beginning new implementation.
The project-root planning checkout is historical and contains no runnable app.
This review and documentation update use the existing visualizer worktree.

```sh
./scripts/run-dev
```

Run from the current app checkout with its private `.env.local`. This starts the
Vite frontend on 127.0.0.1:5173, Node queue service on :8980, and real Python
worker on :8971 (or reuses a compatible worker). PH ID configuration is loaded
privately; without it the development launcher uses labelled fake authentication.
Fixture media requires an explicit flag. Defaults store service state in
`.local/service` and worker data in `.local/dev-worker`; `--data` changes the
service directory. Preserve the matching service and worker directories when
reusing music; copying credentials does not copy queues or cached assets.

The review started the normal stack with real PH ID, real worker and live catalog
matching. `/admin` loaded its PH ID sign-in screen. No fresh live sign-in, source
download, session mutation or physical audio check was performed for that scan.
This is a development launcher, not a production process supervisor or ingress.

## Security and deployment follow-up (2026-11-06)

The user explicitly requires **organizer sign-in for the entire `/display` page**.
It is not publicly viewable. This supersedes the earlier universal/public-display
access decision. `/visual` also requires organizer access because it mounts the
same player. After login, playback is automatic; no pairing or exclusive lease
was reintroduced. Multiple signed-in organizer displays may still play.

The server now checks credentials before every SSE snapshot using indexed local
SQLite lookups (no PH ID network request in the update path). Logout immediately
ends affected streams. Expiry/revocation closes idle streams by the next five-second
heartbeat, and always before sending another snapshot. Automatic player tokens
also require a currently valid organizer cookie on each HTTP request. Old public
player tokens and copied tokens without an organizer session cannot report or
subscribe as players. Legacy admin-issued paired credentials remain for fixtures.

Production scaffolding is now included: `scripts/run-production`, operator env,
Caddy and systemd examples under `deploy/`. See [operator deployment guide](DEPLOYMENT.md).
No private environment file is loaded by that launcher. Production refuses fake
identity/media, mismatched or local HTTP origins, missing PH ID configuration,
and relative service-storage paths. The launcher requires explicit persistent
worker storage too. This is code/configuration preparation, not a deployed server.

## How the app works now

- `/admin` and `/queue` use the dark official PH component styling. Admins sign in
  through PH ID, manage nights/queues, and issue playback commands. Attendees sign
  in, search/preview a match, and submit. Both pages remain silent.
- `/display` requires organizer PH ID login, then connects automatically and stays connected between nights. No night
  shows **Night not started**. Start night starts prepared music; End night stops
  it. Reload resumes near the last actual checkpoint (normally a five-second
  report interval). There is no pairing, exclusive display lock, startup lease
  wait, or app activation button. Firefox must allow site autoplay for unattended
  starts. Several display tabs may play simultaneously by explicit user decision.
- Use one live player page for venue output. `/visual` is the organizer-only retained tuning lab
  and can also play; `/visual?silent=1` is a silent layout view. Avoid opening an
  extra live preview while listening in Firefox.
- The display uses the approved stationary mirrored soundbar, real FFT analysis,
  purple/black Bayer dithering, now-playing strip, queue and request QR. The exact
  preset is `references/soundbar-approved-settings.json`; lab storage does not
  override it. Experimental wisp/warp renderers were removed.
- Auto mode defaults to one request after 15 elapsed master minutes. Pause,
  buffering and disconnect do not freeze that interval; seeking does not jump it.
  Empty turns reset it. Ordinary tracks through exactly 360 seconds finish first;
  longer mixes may be interrupted and resume at their saved position. Deliberate
  pause waits for organizer resume before starting a due request.
- Organizers can choose Master only or Requests only, set the Auto interval
  within 1–120 minutes, and use Play now. Requests only drains ready requests and
  waits silently when empty. These explicit overrides supersede the original
  plan's unconditional one-request-per-turn language; Auto retains that rule.
- Three accepted requests per PH ID per admin-managed night; invalid submissions
  consume none. Technical preparation/playback failures refund allowance.
  Deliberate admin removal/skip does not automatically refund. Night changes, not
  midnight, reset allowance. Request duration remains strictly under six minutes.
- Node owns durable SQLite queues, commands, scheduling, sessions and checkpoints.
  Browsers receive snapshots over SSE with polling recovery and acknowledge
  actual playback. SQLite supports one service writer, not a replicated fleet.
- Python resolves/prepares bounded, completed, seekable audio-only assets. Active
  and suspended master assets stay pinned; unused cache has bounded cleanup.
  YouTube is the audio source. Spotify/Apple links supply metadata for bounded
  YouTube matching, not direct playback. Missing/ambiguous/restricted audio fails
  clearly. Playlist-only imports are not implemented despite the original plan.

## Deployment verdict: prepared for operator setup; host verification pending

The local app and production frontend build pass routine checks. The following
records fixed code issues and remaining release gates; passing the build alone
does not satisfy the operator/environment checks.

1. **Stream authorization fixed in code.** Streams reauthorize before every
   snapshot; logout, session expiry and device revocation have HTTP regressions.
   This adds only local indexed lookups, without an identity-provider round trip.
2. **Display reporting access fixed in code.** The whole display requires organizer
   login. `display.connect` is admin-only; automatic token use also requires a
   valid organizer session. Anonymous/attendee registrations and token-only access
   are rejected. No public-viewer mode or network-trust setup is retained.
3. **Finish deployment on the existing server.** Runtime-portability review found
   no developer home-directory references in app/service/worker runtime code.
   Explicit data paths select server storage; databases/directories are created
   automatically there. The operator must provision persistent disk/permissions,
   supervise services, configure ingress/HTTPS, backup/restore and DNS, and verify
   the server can fetch real audio. Checked-in launcher/proxy/systemd examples
   supply a starting point; they have not been applied to the actual host.
4. **Verify production identity and QR.** Configure the exact production callback,
   origin, organizer roles and stable session secret. Test sign-in/logout and
   attendee rejection from admin commands. Build with the intended
   `VITE_JUKEBOX_PUBLIC_ORIGIN` if needed; a localhost QR is not phone reachable.
   Get the actual hosting target before changing the separate DNS repository.
5. **Rehearse the real environment.** Use isolated preview data/credentials, test
   source access and seeking from the hosted network/origin, then Firefox on the
   venue laptop/HDMI. Test sleep/reconnect, repeated nights, phone QR, emergency
   stop, fallback audio and restore/rollback. A disconnected display can keep
   buffered audio playing until it receives a remote stop after reconnection.

## Original scan evidence (2026-11-06, before organizer-login changes)

`./scripts/check` passed: 21 Python tests, five policy tests, 179 TypeScript tests,
both TypeScript checks, JS syntax check and production frontend build.
The review changed documentation only; no production/DNS change was made.
Firefox 159.0 rerun passed all 16 playback/recovery checks using isolated service,
worker, browser profiles, owned synthetic audio and a null audio sink. It verified
native autoplay blocking/site permission, silent admin/attendee profiles, pinned
suspended media, request/resume, normal-song boundary, refresh without double
charging, bounded failure/refund, concurrent displays, short/long outages, five
night cycles, checkpoint reload, stale snapshot rejection and exhausted-master
silence. Measured mix resume seek error was 0.000 seconds; five night starts
reached playback in 274–351 ms. These are local fixture measurements, not venue
guarantees. No HDMI output or hosted source access was verified.

The compact [Firefox scan evidence](evidence/deployment-scan-firefox.json) records
this run. Full local output is `.local/player-firefox-evidence.json` (untracked).
Prior Firefox/source results in PLAYER-CONNECTION-AUDIT.md and DECISIONS.md remain
historical evidence, not proof of current hosting or HDMI behavior.
Documentation relative links and `git diff --check` also passed.

## Follow-up verification (2026-11-06)

The final follow-up passed `./scripts/check`: 21 Python tests, five policy tests,
187 TypeScript tests, both typechecks and the production frontend build. Focused
production validation/launcher tests also passed after the distinct-storage guard.
The real launcher booted Node/Python using temporary absolute service/worker paths,
created both databases there, rejected fake auth in production, and stopped both
services when terminated. No provider credentials or source traffic were needed.

Firefox 159.0 passed all 18 checks, including organizer gating before display/audio
mount, independent organizer sessions, logout unmounting audio and a fresh login
restoring playback, plus the prior audio/seek/failure/refund/outage/reload/night
workflows. Five night starts reached playback in 300–351 ms; the tested mix resume
seek error was 0.000 seconds. These are local fixture measurements, not a latency
guarantee. [Follow-up Firefox evidence](evidence/organizer-display-firefox.json).

Source and production-bundle checks found no developer-home path or laptop
frontend address. The deployed-origin QR behavior has a regression test.
Documentation links, Python verifier syntax and `git diff --check` passed.
Localhost was restarted with the same private PH ID/worker configuration and
saved data. Health checks pass; anonymous automatic registration returns HTTP 401.
The actual operator host/proxy configuration, live organizer role, production
identity/source access, backups/restore and HDMI remain unverified.
