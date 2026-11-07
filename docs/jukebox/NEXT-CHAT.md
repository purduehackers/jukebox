# Start the next chat here

Updated 2026-11-06. The runnable app and deployment preparation are on GitHub
`purduehackers/jukebox`, branch `main`. Start from freshly fetched `origin/main`;
older planning/phase branches are historical. Do not rebuild completed phases.

Read AGENTS.md, CURRENT-STATUS.md, DECISIONS.md and DEPLOYMENT.md first.

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
- Verification passed: 187 TypeScript tests, 21 Python tests, five policy tests,
  typechecks/build and 18 Firefox checks. See organizer-display-firefox.json under
  evidence/. These are local fixture tests, not server/HDMI proof.

## Remaining deployment work

The user supplied an announcement that organizers can manage organizer-run
projects on `phack.sh` and inspect their server permissions with `sudo -l`.
Treat phack.sh as a potential existing deployment target; its access, Jukebox
project registration, resources and runtime have not been verified. No server
login, deployment, DNS change or message to an operator has been performed.

Use DEPLOYMENT.md for operator setup: persistent directories, private PH ID and
session configuration, supervised Node/Python, same-origin HTTPS ingress, DNS,
backups/restore, real-source egress and Firefox/HDMI rehearsal. Production code
creates databases in the configured server directories; disk provisioning,
permissions and backups remain operator responsibilities.

## Private local configuration

Credentials, local databases and cached music are deliberately not on GitHub.
The existing local app checkout is
`/home/patio/.t3/worktrees/purdue-hackers-jukebox/feat-jukebox-visualizer-next`.
It has the authorized private PH ID configuration and references to existing
service/worker state. Inspect/reuse that local configuration for normal local
previews without printing secrets. Do not silently switch to fixture auth/media
or replace saved state. A fresh clone requires its own private configuration.
