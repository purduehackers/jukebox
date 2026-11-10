# Current implementation and deployment readiness

Updated 2026-11-09 (America/Indiana/Indianapolis). This is the current-state
companion to the original approved plan, not a new product approval request.
Later user decisions in DECISIONS.md supersede the original plan where they differ.

## Baseline and local startup

The consolidated `main` includes the Astro/Bun/uv rewrite (original parent
`e95376c`) and the subsequent 2026-11-09 local changes. See [migration record](ASTRO-BUN-MIGRATION.md)
for verification and [operator guide](DEPLOYMENT.md) for Podman on phack.sh.

Run `bun install --frozen-lockfile`, `uv sync --locked`, then `bun run dev`.
Astro serves the entire app/API on 127.0.0.1:5173; the uv-managed Python worker
remains private on :8971. Development loads private `.env.local` and requires
real PH ID unless `--dev-auth` is explicitly requested. Real media is the default.
Private configuration/state are not copied into fresh worktrees automatically.
Production uses `bun run build` and `bun start`, with inherited runtime environment
and absolute persistent paths; it never reads `.env.local`.

Latest migration checks passed: 21 Python and 192 Bun tests, typechecks/build,
18 production-player Firefox checks, 61 admin checks, six queue-controls checks,
dev smoke and actual local Podman health/persistence checks. See the migration
record for scope and remaining operator gates.

Latest local changes (2026-11-09): display uses the user's exact selected preset
in `references/soundbar-display-settings-2026-11-09.json`; both lower boxes match
the dashboard clock's 194 CSS px height at the default root size. Master/request
changes have 7-second master-only volume ramps and 3-second silent gaps. The
request never fades out. See [volume transitions](VOLUME-TRANSITIONS.md).
Admin/queue have the Checkpoints reference's animated dither backdrops in yellow
and purple. The top `Ban…` menu manages persistent, server-enforced PH ID username
bans; legacy sessions need re-login to request while any bans exist. Schema is 5.
The visualizer follows actual outgoing playback and the volume envelope during
fades. Accepted queue additions persist actor usernames and song titles in the
admin action log, shared across organizers and reloads. The user's testing pause
was specific to repeated audio-visualizer verification while testing manually.
Normal unit/Bun tests, typechecks, builds and relevant checks for other work
remain expected. No new venue validation is claimed.

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
  preset is `references/soundbar-display-settings-2026-11-09.json`; lab storage does not
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
- Bun owns durable SQLite queues, commands, scheduling, sessions and checkpoints.
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

## Normal verification resumed (2026-11-09)

21 Python tests, both TypeScript checks, Astro check and production build passed.
The full Bun run passed 200 tests and found three test-fixture failures: the
pre-artwork downgrade retained the new bans table, the v3 upgrade asserted the
old schema count, and the ban test closed SQLite before background work settled.
Fixtures now recreate the old schema correctly, verify the migrated bans table,
and settle work before restart/close. All 31 tests in the three affected files
passed on rerun. No application behavior changed. No browser/HDMI tests were rerun.
