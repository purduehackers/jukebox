# Operator deployment guide

Updated 2026-11-14. Target: Podman on phack.sh behind its existing host Caddy.
No server login, deployment, DNS change or operator message is part of this rewrite.

## Pull and run on phack.sh

Pushes to `main` run `.github/workflows/publish-container.yml` on GitHub's
Linux AMD64 runner and publish `ghcr.io/purduehackers/jukebox:latest` plus
`sha-<full-commit-SHA>`. Manual runs are also available on `main`. Publishing
uses the built-in `GITHUB_TOKEN` with package-write permission; no extra registry
secret is needed. The workflow publishes images without deploying the server.

Pull the built image instead of building on phack.sh, where the native
Astro/Vite build dependency crashed on a CPU without AVX:

```sh
podman pull ghcr.io/purduehackers/jukebox:latest
```

For a reproducible release or rollback, pull the `sha-<full-commit-SHA>` tag
instead. If anonymous pulls are denied, make the GHCR package public or
authenticate with `podman login ghcr.io` using an account/token with package-read
access. Runtime compatibility and real-source access on phack.sh still require
verification.

## Local image build and runtime setup

The image packages the production Astro server, Bun 1.4.4 and the uv-locked Python
worker with FFmpeg. One container port serves HTML, static assets, API, auth, SSE
and audio. Caddy proxies the entire domain; there are no frontend files to copy
onto the host. The worker is private on container loopback :8971.

```sh
# Optional: build locally on a compatible CPU instead of pulling from GHCR.
podman build --format docker -t localhost/jukebox:local -f Containerfile .
podman volume create jukebox-data
cp deploy/jukebox.env.example ~/env
chmod 600 ~/env
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

The process runs as container user `bun` (UID 1000). A fresh named volume inherits
the image directory ownership. Existing volumes/bind mounts need matching rootless
UID mapping and, on SELinux hosts, an appropriate label such as `:Z`. Preserve the
volume across container replacement. Run one authority and worker per data set;
never run replicas against the same SQLite files.

`/healthz` checks the web authority; `/readyz` also checks the worker. The supervisor
stops the stack if either owned child exits. Tini forwards signals and reaps
processes; shutdown stops SSE, HTTP, scheduler and worker. The Quadlet health policy kills an unhealthy app container so systemd can restart it.

## Host Caddy and reboot startup

The deployment follows [Podman UNIX socket forwarding](https://kasad.com/blog/2026/11/11/podman-unix-socket-forwarding/):
`jukebox.pod` shares a network namespace between the app and a `socat` proxy.
The app keeps TCP :8080 inside the pod; no host TCP port is published. Systemd
creates `~/jukebox.sock` and passes its listening descriptor (FD 3) to the proxy,
which forwards connections to `127.0.0.1:8080` inside the pod. The worker remains
private on :8971.

Install the Quadlets and socket unit as the container operator:

```sh
mkdir -p ~/.config/containers/systemd ~/.config/systemd/user
cp deploy/jukebox.container deploy/jukebox.pod deploy/jukebox-proxy.container ~/.config/containers/systemd/
cp deploy/jukebox-proxy.socket ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start jukebox-pod.service
systemctl --user status jukebox-pod.service jukebox.service jukebox-proxy.service jukebox-proxy.socket
curl --fail --unix-socket "$HOME/jukebox.sock" http://localhost/readyz
```

The private environment file is `~/env`, matching `EnvironmentFile=%h/env`.
The host needs `/usr/bin/setfacl` and the `caddy` group. The socket's
`ExecStartPost` grants `g:caddy:rw` after every creation. Caddy also needs search
permission on the operator's home directory and any parent directories; if
needed, grant just traversal with `setfacl -m g:caddy:x "$HOME"`. Socket permissions
alone cannot grant directory traversal.

Adapt `deploy/Caddyfile` in the existing host configuration, replacing
`/home/OPERATOR` with the operator's absolute home path. Caddy proxies to
`unix//home/OPERATOR/jukebox.sock`, preserving Host/Origin and streaming SSE.
`%h` is expanded by systemd, not Caddy. The Caddyfile is a reference, not a second
Caddy instance to start. TLS and DNS remain operator tasks; DNS changes belong
in `purduehackers/dns`.

`jukebox.service` is now generated solely from `jukebox.container`; the standalone
native service file has been removed. If the former native service was installed,
stop/disable it and remove its installed unit before reloading systemd. Remove
any manually installed user `jukebox.service` that would override Quadlet's
generated service. Preserve the environment and data when migrating.

The pod starts both containers automatically at user-manager startup. Arrange
user lingering with the server operator for reboot operation without login.
The app retains health checks and restart-on-failure; the proxy restarts on
failure. Stopping `jukebox-pod.service` also stops both containers and the socket.

## Native development

Install Bun 1.4.4+, uv, Python 3.11–3.14, FFmpeg/ffprobe and Bash. Run
`bun install --frozen-lockfile`, `uv sync --locked`, then `bun run dev` on :5173
with private `.env.local`. Production deployment uses the container units above.

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
The runtime rewrite itself adds no schema migration; later features append
migrations 5 (username bans), 6 (request-timer pause timestamp) and 7
(request-quota toggle `quota_enabled`) — current schema is 7. Back up before
upgrading, and restore compatible data when rolling back to code that only
understands an older schema. The new authority lock is a separate
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
- Scan the QR on a phone. The display's QR is a static branded image
  (`public/qr.png`) that always encodes `https://jukebox.purduehackers.com/queue`;
  the printed link beside it still follows the instance origin, so a local preview
  stays reachable by typing that URL.
- Set Firefox's persistent Autoplay permission on the venue laptop; verify HDMI,
  sleep/wake, repeated nights and emergency stop. Buffered audio can continue
  during a control outage, so keep a physical/local stop method.
- Replace/restart the container with the same volume, restore a backup in isolated
  storage, and confirm queues, quotas, sessions, checkpoints and worker assets.

Local fixture tests and container smoke results are recorded in
[the migration record](ASTRO-BUN-MIGRATION.md). They do not establish production
PH ID, server-source egress, DNS, actual Caddy operation or HDMI behavior.


### Audio cache capacity

The worker defaults to a bounded 50 GiB cache. Set `JUKEBOX_CACHE_BYTES` in the
private environment to change it (256 MiB to 1 TiB), or pass `--cache-bytes`
directly to the worker. Confirm enough free space on the persistent volume.
The worker reserves up to 256 MiB for each preparation and protects queued,
playing and suspended audio from eviction. A cache full of protected tracks
rejects new jobs rather than deleting those tracks. Remove unused master entries
or increase the budget when this happens. Unpinned assets are cleaned normally.
The previous 512 MiB default could block new jobs with only about 256 MiB pinned.
