# Purdue Hackers Jukebox

Audio-only music queue and Firefox venue player for Hack Night. Astro owns the
pages, middleware and API routes; Bun runs the web application and durable SQLite
queue authority. Pages and chrome use the official Purdue Hackers `.astro`
components (`src/components/ph/`) styled with Tailwind v4 through the official
`@tailwindcss/vite` plugin; React islands ship only where interactivity is needed
(admin/queue controls, display player, visualizer). The private Python worker
uses uv, yt-dlp and FFmpeg to prepare seekable audio.

Production target: `https://jukebox.purduehackers.com`, in one Podman container
behind phack.sh's existing Caddy. Deployment and venue/HDMI checks remain pending.
See the [operator guide](docs/jukebox/DEPLOYMENT.md),
[migration record](docs/jukebox/ASTRO-BUN-MIGRATION.md) and
[current handoff](docs/jukebox/NEXT-CHAT.md).

Current state (2026-11-14): accepted links are YouTube (the only audio source) plus
Spotify, Apple Music and Deezer track links (metadata-only, matched to YouTube).
Link validation is ID-only — share/tracking parameters such as YouTube Music's
`&drli=1` are discarded, not rejected. Admins can disable the per-person request
quota (`quota.set`, schema migration 7), and the display's request QR is a static
branded image (`public/qr.png`) for the live site while the printed URL still
follows the instance origin.

## Local setup

Install Bun 1.4.4+, uv, Python 3.11–3.14, FFmpeg/ffprobe and Firefox.
On CachyOS/Arch use `yay -S --needed bun uv python ffmpeg firefox` as the normal user.

```sh
bun install --frozen-lockfile
uv sync --locked
```

Copy `.env.example` to private `.env.local` and configure real PH ID; see
[PH ID setup](docs/jukebox/PH-ID-SETUP.md). Normal startup requires PH ID and real
media. Existing authorized private configuration and state can be reused; neither
is included in a fresh worktree. Startup never silently enables fake sign-in.

```sh
bun run dev
# Optional separate service state:
./scripts/run-dev --data .local/my-night/service
```

Open `http://127.0.0.1:5173/admin`, `/queue`, `/display` or `/visual`.
The Astro dev server handles the entire site and API on one port. The worker
runs privately on loopback :8971. An occupied app port fails without stopping
another app. Development can reuse a compatible running worker; use
`--worker http://127.0.0.1:8972` to select a separately managed worker.
`./scripts/run-local --port 8972 --data .local/my-worker` runs only the worker.

`/display` and `/visual` require organizer PH ID login. Set Firefox's persistent
site Autoplay permission to **Allow Audio and Video**. Start night in `/admin`
starts prepared music; End night stops it and shows **Night not started**.
Reloads resume near the last checkpoint. Multiple display tabs can play, so use
one for venue output. There is no pairing, exclusive lease or sound-enable UI.
Admin and attendee pages remain silent. `/visual?silent=1` is a silent tuning view;
lab settings do not change the display's selected preset, archived in
`docs/jukebox/references/soundbar-display-settings-2026-11-09.json`.

## Production

```sh
bun run build
bun start
```

Production requires private runtime environment variables and absolute persistent
service/worker paths. It never loads `.env.local`. The Podman image includes the
built Astro server, Bun, uv-managed Python and FFmpeg, exposing only port 8080.
The operator manages no separate frontend files. Full commands, Quadlet, Caddy,
backup and upgrade guidance: [DEPLOYMENT.md](docs/jukebox/DEPLOYMENT.md).

## Verification

```sh
bun run check
uv run --locked python scripts/verify-player.py
uv run --locked python scripts/verify-fades.py
uv run --locked python scripts/verify-admin.py
uv run --locked --group display python scripts/verify-display.py
uv run --locked python scripts/verify-queue-controls.py
# Development launcher smoke:
uv run --locked python scripts/verify-player.py --dev-smoke
```

Build before running the browser scripts. Tests use disposable state, explicit
fixture authentication/media, fresh Firefox profiles and dedicated null audio
sinks. The production launcher regression uses placeholder PH ID configuration
without contacting the provider. No routine test needs production credentials or
provider traffic. Evidence is written under `.local/`; none proves HDMI output.

For an explicit offline UI demo only:

```sh
./scripts/run-dev --dev-auth --fixture-media --data .local/offline-demo
```

The private phase-1 worker proof remains available through `scripts/run-local` at
`http://127.0.0.1:8971/display`. Its diagnostic activation controls are separate
from the actual Astro display. Historical source/codec evidence and limitations:
[phase-1 findings](docs/jukebox/PHASE-1-FINDINGS.md) and
[link compatibility](docs/jukebox/LINK-COMPATIBILITY.md).
Shared behavior/API: [contract](docs/jukebox/PHASE-2-CONTRACT.md).
