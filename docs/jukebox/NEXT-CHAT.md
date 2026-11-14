# Start the next chat here

Updated 2026-11-14. The consolidated `main` baseline includes the Astro/Bun/uv
rewrite and all subsequent local UI, visualizer, transition, ban and action-log work.
The `astro-migration` branch currently carries the newest commits ahead of `main`
(Tailwind v4 via the official plugin, official PH `.astro` components) plus the
uncommitted 2026-11-14 work summarized at the bottom of this file. Read
[migration record](ASTRO-BUN-MIGRATION.md) and [deployment guide](DEPLOYMENT.md)
for the current runtime. Start new work from freshly fetched `origin/main` (or the
newer `astro-migration` head when continuing that work).
Do not restart completed phases. Read AGENTS.md, CURRENT-STATUS.md and DECISIONS.md.

## Current behavior and completed work

- The entire `/display` page and `/visual` require organizer PH ID login.
  There is no public display-viewing mode. After login playback is automatic;
  multiple organizer displays may play. No pairing or exclusive lease.
- The server owns queues/scheduling. Actual-player reports inform end/failure and
  resume state; automatic player tokens also require a valid organizer session.
- SSE rechecks local credentials before updates; logout/expiry/revocation cannot
  keep receiving privileged data. No PH ID network check is added per update.
- Display uses the approved stationary soundbar. Its countdown says NEXT REQUEST.
- Production launcher, environment/Caddy/systemd examples and the operator guide
  are committed. Browser URLs follow the deployed origin; production QR/link is
  `https://jukebox.purduehackers.com/queue` when served there.
- Migration verification: 192 Bun tests (including five policy tests), 21 Python
  tests, typechecks/build, 18 production-player Firefox checks, 61 admin checks,
  six real-audio queue-controls checks and dev smoke. Actual local Podman build,
  readiness and volume replacement passed. See astro-bun-*.json under evidence/.
  Production PH ID, server-source egress and HDMI remain unverified.

## Remaining deployment work

The user supplied an announcement that organizers can manage organizer-run
projects on `phack.sh` and inspect their server permissions with `sudo -l`.
Treat phack.sh as a potential existing deployment target; its access, Jukebox
project registration, resources and runtime have not been verified. No server
login, deployment, DNS change or message to an operator has been performed.

Use DEPLOYMENT.md for operator setup: persistent directories, private PH ID and
session configuration, supervised Astro/Bun/uv-managed Python, same-origin HTTPS ingress, DNS,
backups/restore, real-source egress and Firefox/HDMI rehearsal. Production code
creates databases in the configured server directories; disk provisioning,
permissions and backups remain operator responsibilities.

## Private local configuration

Credentials, local databases and cached music are deliberately not on GitHub.
The original local app checkout is
`/home/patio/.t3/worktrees/purdue-hackers-jukebox/feat-jukebox-visualizer-next`.
It has the authorized private PH ID configuration and references to existing
service/worker state. Inspect/reuse that local configuration for normal local
previews without printing secrets. Do not silently switch to fixture auth/media
or replace saved state. A fresh clone requires its own private configuration.

The running local checkout is `/home/patio/Projects/jukebox-astro-bun`. It
reuses the same private configuration and service/worker
paths for the user-requested local preview. It has a private `.env.local` and
a pre-preview SQLite backup under `.local/`. Neither is committed. Local tools
for this session are under `/tmp/jukebox-toolchain/usr/bin`; add that directory
to PATH if Bun/uv are not installed on the host.

## Latest local work (2026-11-09)

The user finalized the plain negative soundbar preset, now archived in
`references/soundbar-display-settings-2026-11-09.json` and imported by /display.
Master/request volume transitions are documented in VOLUME-TRANSITIONS.md.
Reference Paper Design UI backdrops are on /admin (yellow) and /queue (purple).
Top admin Ban… opens persistent username ban management; schema migration 5
is appended. Request checks use verified PH ID usernames, requiring re-login
for older sessions if any bans exist. Lower display row matches the dashboard
clock height, 12rem + 2px (194 CSS px). Preserve the user's exact settings.
Accepted queue additions record the verified actor username (saved display-name
fallback for legacy sessions) and resolved song title in durable events. Admin
action logs show these across organizers/reloads; older unattributed events are
not assigned invented usernames. The visualizer follows actual outgoing master
audio through fades and scales smoothly with the local volume envelope.

The user approved the local result and requested committing/pushing all source
work to main with updated docs. This publishes code, not a phack.sh deployment.
Testing clarification (2026-11-09): the earlier testing pause applied only to
repeated audio-visualizer verification while the user tested it manually. Run
normal unit/Bun tests, typechecks, builds and relevant checks for other changes.
Do not interpret that pause as a project-wide testing restriction.

## Normal verification resumed (2026-11-09)

21 Python tests, both TypeScript checks, Astro check and production build passed.
The full Bun run passed 200 tests and found three test-fixture failures: the
pre-artwork downgrade retained the new bans table, the v3 upgrade asserted the
old schema count, and the ban test closed SQLite before background work settled.
Fixtures now recreate the old schema correctly, verify the migrated bans table,
and settle work before restart/close. All 31 tests in the three affected files
passed on rerun. No application behavior changed. No browser/HDMI tests were rerun.

## Local visualizer improvements (2026-11-10)

Reuses the canvas image buffer and skips pixels outside the soundbar field.
CPU-only comparisons at 640x400 measured 7–9x faster sampled nonzero frames;
96 byte-for-byte comparisons preserved coverage. These are not Firefox frame
measurements. The visualizer and now-playing border now use the dashboard
clock's live Lightning Time OKLCH gradient, superseding solid purple ink.
Changes are also applied to the existing local preview checkout.

## Latest work (2026-11-14, `astro-migration`)

Committed on `astro-migration` ahead of `main`: Tailwind v4 loads through the
official `@tailwindcss/vite` plugin (`f85f56c`), and pages use the official PH
`.astro` components in `src/components/ph/` with React islands only for the
interactive admin/queue controls, display player and visualizer (`4b5f060`).

Further 2026-11-14 changes in the working tree:

- The authority HTTP surface is injected in `astro.config.mjs` (the
  `jukebox-authority` integration's `astro:config:setup`) as
  `/auth/[...slug]`, `/api/v1/[...slug]`, `/media/[assetId]`, `/metrics`,
  `/healthz` and `/readyz`, handled by `src/server/routes/{auth,api,media,probes,readyz}.ts`
  delegating to `transport.handle`; the one-line `src/pages` shims are deleted.
  Middleware hands the per-process runtime to routes via `Astro.locals.runtime`
  (typed in `src/env.d.ts`). Dev restarts settle the previous runtime before
  creating a new one and install a SIGTERM/SIGINT shutdown backstop; Vite
  pre-bundles react/react-dom and dedupes React because `@purduehackers/time`
  ships a nested React 18.
- Link validation is ID-only in both parsers (`src/core/sources.ts`,
  `jukebox/media.py`): only the provider host/path shape and the content ID are
  checked; every other query parameter and the fragment are discarded because the
  canonical URL is rebuilt from the ID alone. YouTube Music `&drli=1` share links
  now parse. Credential/port/lookalike/control-character/invalid-ID/playlist
  rejections are unchanged; nothing unvalidated is ever forwarded.
- Deezer is a link-only provider like Spotify/Apple: `deezer.com` track URLs
  canonicalize to `https://www.deezer.com/track/<id>`; metadata comes from the
  public no-auth `api.deezer.com/track/<id>` endpoint; playback stays YouTube-only.
- Admin request-quota toggle `quota.set {enabled}` (admin-only, idempotent)
  persists in the `playback` singleton (`quota_enabled`, migration 7 — schema is
  now 7) and the snapshot carries `quotaEnabled`; `/queue` hides the allowance
  line while off, and submissions still count so re-enabling blocks immediately.
- The display request QR is a static branded image (`public/qr.png`, served at
  `/qr.png`) encoding `https://jukebox.purduehackers.com/queue`;
  `qrcode-generator` is removed. The printed link beside it still follows the
  configured/current origin, and `scripts/verify-display.py` now expects the live
  URL inside the QR image.

Verification rerun 2026-11-14: 23 Python tests, 220 Bun tests across 33 files
(including the policy suite), both TypeScript checks plus Astro check (0 errors)
and the production build all passed. No browser/HDMI checks were rerun; the
earlier Firefox evidence above stands as recorded.
