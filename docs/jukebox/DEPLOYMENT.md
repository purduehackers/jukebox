# Operator deployment guide

Updated 2026-11-06. Prepared for deployment setup; the actual host, ingress, DNS,
PH ID roles, audio-source egress and venue output still need operator verification.
No deployment, DNS change or operator message has been performed by these changes.

## What the operator receives

The app has a production frontend build and a same-host production launcher for
the durable queue service and audio worker. No developer home directory or laptop
IP is embedded in app/service/worker runtime paths. Loopback backend addresses
refer to processes on the server, not the venue laptop. The venue laptop runs
Firefox; its browser obtains audio over the deployed same-origin `/media/*` path.

- `npm run build:app` creates portable `dist/app` static files.
- `npm start` / `scripts/run-production` runs the Node service and Python worker.
- `deploy/jukebox.env.example` lists production variables and persistent paths.
- `deploy/Caddyfile` demonstrates HTTPS forwarding of the whole site to Node with
  unbuffered SSE. The operator can adapt these rules to their existing proxy.
- `deploy/jukebox.service` demonstrates systemd startup/restart and server storage.

These are operator-adaptable examples, not an assumption about Purdue Hackers'
actual server layout. `/opt/jukebox`, `/var/lib/jukebox` and the `jukebox` service
account are installation choices. Run one queue-service writer and one worker
against their respective databases; do not start replicas against the same files.
The production launcher manages a same-host worker. Containers/separate hosts
need equivalent private networking and mounts and can launch `main.ts` directly.

## Install and configure

1. Confirm the existing server has adequate persistent disk/resources and access
   to the required audio sources. Install Node 22.18+ (local verification used
   Node 26), Python 3.11+, FFmpeg/ffprobe, Bash and the chosen HTTPS proxy. On
   Arch/CachyOS use Yay as the normal user for package installation.
2. Place the current app checkout at the chosen installation directory. As the
   deployment/service owner, install dependencies and build:

   ```sh
   npm ci
   python -m venv .venv
   .venv/bin/python -m pip install -r requirements.txt
   npm run build:app
   ```

   Install from the lockfile with build dependencies present; Vite is required at
   build time. The runtime launcher does not invoke Vite or install dependencies.
3. Create the service account and writable persistent state root. The example
   systemd unit creates `/var/lib/jukebox` for its service user. Service and worker
   create their own databases/subdirectories in the configured locations. Keep
   these paths outside replaceable release folders and preserve them on upgrades.
4. Copy `deploy/jukebox.env.example` to private operator configuration, such as
   `/etc/jukebox.env`, and fill in PH ID credentials plus a stable random session
   secret (at least 32 characters). Set:

   ```text
   JUKEBOX_ORIGIN=https://jukebox.purduehackers.com
   JUKEBOX_PHID_REDIRECT_URI=https://jukebox.purduehackers.com/auth/callback
   JUKEBOX_SERVICE_DATA=/var/lib/jukebox/service
   JUKEBOX_WORKER_DATA=/var/lib/jukebox/worker
   ```

   The production launcher receives its environment from the supervisor; it does
   not read `.env.local` or reuse developer credentials. `NODE_ENV=production`
   refuses fake auth/media, absent PH ID configuration, HTTP/local or malformed
   public origins, callback mismatches, short session secrets and relative service
   data paths. The launcher also requires absolute worker storage. Internal
   ports default to service 8980 and worker 8971; both bind to loopback.
5. Have the PH ID app owner register the exact production callback and grant
   venue organizers `organizer` or `admin` roles. The whole `/display` page and
   `/visual` require organizer sign-in. `/queue` attendees still use ordinary PH ID.
   Plan a fresh venue sign-in before each night; sessions currently last 12 hours.
6. Adapt/install the systemd unit and proxy configuration. Proxy the whole site to Node (native default port 8980, container port 8080);
   Node serves `dist/app`. Keep secret configuration private. Start the service and check
   its logs and private `/healthz`. The launcher terminates both child processes
   if either exits so the supervisor can restart the complete stack.
7. Obtain the real server/ingress DNS target and make the change through
   `purduehackers/dns` using that repository's procedure. Obtain/renew HTTPS
   certificates through the actual ingress. Do not copy a different app's target.

## URLs, QR and storage behavior

Browser API/auth/media URLs are relative to the site. QR and printed request links
use `window.location.origin` by default: visiting the production hostname gives
`https://jukebox.purduehackers.com/queue`. No frontend source edit is needed.
Do not set `VITE_JUKEBOX_PUBLIC_ORIGIN` to localhost in a production build. It is
an optional build-time override for a deliberately different attendee origin;
omit it for the standard same-origin deployment.

SQLite state is stored at `JUKEBOX_SERVICE_DATA/state.sqlite3`; worker metadata,
assets and work files live below `JUKEBOX_WORKER_DATA`. They use the server's
filesystem automatically once the operator supplies writable persistent paths.
They do not provision a disk, select a mount, migrate laptop queues or create
backups automatically. Deploying code starts with empty state unless the operator
explicitly migrates a compatible saved service directory and its matching worker
assets/metadata. Keep secrets out of the repository and frontend build.

The worker cache is bounded (default 512 MiB); active/suspended assets are pinned.
Review disk/cache requirements against expected mixes rather than assuming a
small server or ephemeral disk is sufficient. Larger retained media can reach
limits. Operator logs and backup retention also need their own disk limits.

## Verify before announcing it ready for a night

- Actual HTTPS `/admin`, `/queue`, `/display` and `/visual` routes load directly.
  Anonymous/attendee display access is blocked. Organizer sign-in returns to the
  display and enables playback/reporting without pairing or an exclusive lease.
- Sign-out/expired sessions stop privileged streaming and player authorization.
  Invalid/attendee commands are denied. Do not publish worker management routes.
- Real audio prepares from the server network, plays in Firefox, and seeks through
  the deployed `/media/*` proxy with HEAD/Range support. SSE updates arrive without
  buffering. Check actual source failures rather than assuming local success.
- Scan the deployed QR on a phone; verify the displayed URL is the production
  domain. Configure Firefox's persistent site autoplay permission on the venue
  laptop and verify HDMI output, sleep/wake and emergency stop.
- Restart the services and verify saved queues/checkpoints/media. Rehearse with
  isolated preview credentials/state first, then confirm production data paths.

## Backups and rollback

The operator owns the backup destination, schedule, retention and restore drill.
A simple consistent backup can stop the Jukebox service, copy both complete data
directories plus protected configuration, then restart. Copying only an active
SQLite database file can miss WAL data; use SQLite-aware backups if avoiding
service downtime. Protect session/identity data in backups. Test restoring both
state and worker assets to isolated directories before relying on that backup.

Before changing application/schema versions, record the release commit and take
a compatible backup. SQLite migrations run on startup. Restore the matching data
backup when rolling back across an incompatible schema; an older code checkout
alone is not a guaranteed database rollback. Do not run old and new writers
simultaneously against the same state.

A disconnected browser can keep buffered audio playing until it reconnects;
remote End night is not an offline physical mute. Keep a venue fallback and a
local way to stop audio.

## Podman container

The root `Containerfile` builds the frontend with Vite and packages Node, the
Python audio worker and FFmpeg. Node serves the built frontend as well as the API. It runs as the unprivileged `node` user and exposes HTTP
on port 8080. Terminate HTTPS at the host ingress and proxy the entire site to
this port, preserving Host/Origin and streaming responses. Node binds to `0.0.0.0:8080` inside the container; the worker remains private
on container loopback. The host port is published on loopback only. Do not run another
copy against the same volume.

```sh
podman build -t jukebox:local -f Containerfile .
podman volume create jukebox-data
podman run -d --name jukebox --restart=unless-stopped \
  --env-file /etc/jukebox.env \
  --env JUKEBOX_SERVICE_PORT=8080 \
  -p 127.0.0.1:8080:8080 \
  -v jukebox-data:/var/lib/jukebox \
  jukebox:local
podman logs jukebox
```

Use the production environment example and PH ID setup above. The image defaults
to `/var/lib/jukebox/service` and `/var/lib/jukebox/worker`; keep those values when
mounting the volume as shown. A fresh named volume inherits the image directory's
ownership. Bind mounts need permissions for container UID 1000 (with rootless
Podman UID mapping) and an appropriate SELinux label, such as `:Z` where enabled.
Keep the environment file private; never pass secrets as build arguments.
The allowlist in `.containerignore` excludes local state and credentials from the
build context. Image upgrades preserve the named volume; back it up as described
above. Base image tags can move: record image digests for reproducible releases.
The health check probes the Node service; the production launcher
separately supervises the worker. Host reboot startup requires operator setup,
such as a Podman Quadlet/systemd service with the appropriate user linger policy.

Node serves the built app shell at `/`, `/admin`, `/queue`, `/display` and
`/visual`, plus the Vite-generated `/assets/*` files. Assets use immutable cache
headers; the HTML shell is revalidated. Unknown API/auth/media paths and missing
assets return 404 rather than HTML. Vite is only a build/development dependency;
production runs no Vite server. Native installs keep the default loopback bind;
`JUKEBOX_SERVICE_HOST` allows the container to bind its published interface.
