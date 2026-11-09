# Start the next chat here

Updated 2026-11-09. The Astro/Bun/uv rewrite is on `feat/astro-bun-uv` in
`/home/patio/Projects/jukebox-astro-bun`, based on `origin/main` at `e95376c`.
Read [migration record](ASTRO-BUN-MIGRATION.md) and [deployment guide](DEPLOYMENT.md)
for the current runtime. Until integrated, `main` retains the former Node app.
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

The migration checkout reuses the same private configuration and service/worker
paths for the user-requested local preview. It has a private `.env.local` and
a pre-preview SQLite backup under `.local/`. Neither is committed. Local tools
for this session are under `/tmp/jukebox-toolchain/usr/bin`; add that directory
to PATH if Bun/uv are not installed on the host.
