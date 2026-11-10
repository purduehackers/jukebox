# Start the next chat here

Updated 2026-11-09. The consolidated `main` baseline includes the Astro/Bun/uv
rewrite and all subsequent local UI, visualizer, transition, ban and action-log work.
Read [migration record](ASTRO-BUN-MIGRATION.md) and [deployment guide](DEPLOYMENT.md)
for the current runtime. Start new work from freshly fetched `origin/main`.
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
The user asked to stop automated checks and will test locally; do not restart
broad tests merely to recheck the completed work without a new reason/request.
