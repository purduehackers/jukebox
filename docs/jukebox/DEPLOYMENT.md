# Operator deployment guide

Updated 2026-11-09. Target: Podman on phack.sh behind its existing host Caddy.
No server login, deployment, DNS change or operator message is part of this rewrite.

## Build and run on phack.sh

The image packages the production Astro server, Bun 1.4.4 and the uv-locked Python
worker with FFmpeg. One container port serves HTML, static assets, API, auth, SSE
and audio. Caddy proxies the entire domain; there are no frontend files to copy
onto the host. The worker is private on container loopback :8971.

```sh
podman build --format docker -t localhost/jukebox:local -f Containerfile .
podman volume create jukebox-data
mkdir -p ~/.config/jukebox
cp deploy/jukebox.env.example ~/.config/jukebox/jukebox.env
chmod 600 ~/.config/jukebox/jukebox.env
```

Fill the private environment file with the registered PH ID client, client secret,
and a stable random session secret (generate with `openssl rand -base64 32`). Keep:

```text
JUKEBOX_ORIGIN=https://jukebox.purduehackers.com
JUKEBOX_PHID_REDIRECT_URI=https://jukebox.purduehackers.com/auth/callback
JUKEBOX_SERVICE_DATA=/var/lib/jukebox/service
JUKEBOX_WORKER_DATA=/var/lib/jukebox/worker
HOST=0.0.0.0
PORT=8080
JUKEBOX_WORKER_PORT=8971
```

Have the PH ID app owner register that exact callback and grant organizers
`organizer` or `admin` roles. Sessions last 12 hours; sign in before the night.
Secrets are runtime configuration, never build arguments or repository files.
Production refuses fake auth/media, HTTP/local origins, callback mismatches,
short session secrets and relative or identical service/worker directories.

```sh
podman run -d --name jukebox --restart=unless-stopped \
  --env-file ~/.config/jukebox/jukebox.env \
  -p 127.0.0.1:8080:8080 \
  -v jukebox-data:/var/lib/jukebox \
  localhost/jukebox:local
podman logs jukebox
curl --fail http://127.0.0.1:8080/readyz
```

The process runs as container user `bun` (UID 1000). A fresh named volume inherits
the image directory ownership. Existing volumes/bind mounts need matching rootless
UID mapping and, on SELinux hosts, an appropriate label such as `:Z`. Preserve the
volume across container replacement. Run one authority and worker per data set;
never run replicas against the same SQLite files.

`/healthz` checks the web authority; `/readyz` also checks the worker. The supervisor
stops the stack if either owned child exits. Tini forwards signals and reaps
processes; shutdown stops SSE, HTTP, scheduler and worker. Image health status alone
does not restart an unhealthy manual container: use the Quadlet below for that.

## Host Caddy and reboot startup

Adapt `deploy/Caddyfile` in the existing Caddy configuration: reverse proxy
`jukebox.purduehackers.com` to `127.0.0.1:8080`, preserving Host and Origin and
streaming SSE without buffering. Do not expose worker management endpoints.
`deploy/Caddyfile` is a reference, not a second Caddy instance to start.
Obtain the actual ingress target before any change in `purduehackers/dns`; follow
that repository's procedure. TLS and DNS remain operator tasks.

For rootless systemd supervision, copy `deploy/jukebox.container` into
`~/.config/containers/systemd/`, with the private environment file above, then:

```sh
systemctl --user daemon-reload
systemctl --user start jukebox.service
systemctl --user status jukebox.service
```

Use either manual `podman run` or Quadlet for this container. The Quadlet installs
under the user's default target, restarts on failure and kills unhealthy containers
so systemd can restart them. Arrange user lingering with the server operator for
reboot operation without login. Image building remains an explicit release step.

## Native development or service installation

Install Bun 1.4.4+, uv, Python 3.11–3.14, FFmpeg/ffprobe and Bash. On Arch/CachyOS
use Yay as the normal user. From the selected checkout:

```sh
bun install --frozen-lockfile
uv sync --locked
bun run build
```

`bun start` runs the same supervisor and production Astro server, using only
inherited runtime environment. Native operator examples are in
`deploy/jukebox.service`; installation paths/account are choices. Set
`HOST=127.0.0.1` for a native service behind Caddy. Default production port is 8080;
there is no separate service port or production Vite server. Development uses
`bun run dev` on :5173 and loads private `.env.local`.

## Persistence, upgrades and rollback

The existing SQLite schema and migration sequence are preserved. Bun opens the
same `state.sqlite3` format used by the old Node service. Queue, accepted-submission
accounting, sessions and checkpoints remain server-owned. Worker metadata, assets
and work files remain under its separate directory. Browser storage is not queue
authority. New deployments start empty unless compatible state is copied in.

Before upgrading, stop Jukebox and back up both complete data directories and the
private environment file to protected storage. Copying only a live database can
miss WAL data. The operator owns backup location, retention and restore drills.
Never back up only the queue while omitting its referenced worker media.

Stop/remove the old container, build/select the new image, and start its replacement
with the same named volume and environment. Record source commit and image digest
for each release. Restore both data directories and matching code/image if rolling
back across an incompatible migration; code rollback alone is insufficient.
This rewrite adds no schema migration. The new authority lock is a separate
`state.sqlite3.authority-lock` SQLite file; the OS releases it after a crash.
Do not delete it while a process is running. Do not run old and new writers together.

The worker cache defaults to 512 MiB with bounded cleanup; active and suspended
assets are pinned. Verify disk capacity for expected mixes, logs and backups.
The build-context allowlist excludes local secrets and saved state.

## Required checks on the actual host and venue

- Load `/admin`, `/queue`, `/display` and `/visual` over HTTPS. Verify real PH ID
  callback, organizer access, attendee rejection, sign-out and session expiry.
- Prepare real audio from the phack.sh network. In Firefox verify playback,
  HEAD/Range seeking through `/media/*`, SSE updates and reconnects. Catalog
  metadata is never audio; provider restrictions fail clearly without video.
- Scan the QR on a phone. The default destination follows the browser origin,
  so production displays print `https://jukebox.purduehackers.com/queue`.
- Set Firefox's persistent Autoplay permission on the venue laptop; verify HDMI,
  sleep/wake, repeated nights and emergency stop. Buffered audio can continue
  during a control outage, so keep a physical/local stop method.
- Replace/restart the container with the same volume, restore a backup in isolated
  storage, and confirm queues, quotas, sessions, checkpoints and worker assets.

Local fixture tests and container smoke results are recorded in
[the migration record](ASTRO-BUN-MIGRATION.md). They do not establish production
PH ID, server-source egress, DNS, actual Caddy operation or HDMI behavior.
