# Purdue Hackers Jukebox

Audio-only music queue and Firefox venue player for Hack Night. Astro serves the
pages, middleware, and API routes; Bun runs the web application and SQLite queue
authority. UI pages use the Purdue Hackers `.astro` components
(`src/components/ph/`) styled with Tailwind v4 via `@tailwindcss/vite`, with React
islands for interactive controls (`/admin`, `/queue`, `/display`, `/visual`). The
local Python audio worker uses `uv`, `yt-dlp`, and FFmpeg to resolve and prepare
seekable audio.

Production target: `https://jukebox.purduehackers.com`, packaged in a Podman
container behind Caddy. See [DEPLOYMENT.md](docs/jukebox/DEPLOYMENT.md) for
container setup and operations.

## Local setup

Requires Bun 1.4.4+, `uv`, Python 3.11–3.14, FFmpeg/ffprobe, and Firefox.

```sh
bun install --frozen-lockfile
uv sync --locked
```

Copy `.env.example` to `.env.local` and configure Purdue Hackers ID
([PH-ID-SETUP.md](docs/jukebox/PH-ID-SETUP.md)). Normal startup uses real PH ID
and the live audio worker.

```sh
bun run dev
# Optional separate service state:
./scripts/run-dev --data .local/my-night/service
```

Open `http://127.0.0.1:5173/admin`, `/queue`, `/display`, or `/visual`. The Astro
dev server serves both the UI and the API on one port, while the Python audio
worker runs on loopback `:8971` (or pass `--worker http://127.0.0.1:8972` to use
a separately launched `./scripts/run-local --port 8972 --data .local/my-worker`).

`/display` and `/visual` require organizer PH ID login. Configure Firefox's
persistent site Autoplay permission to **Allow Audio and Video**. Starting a
night in `/admin` plays music automatically when a display is open; playback
auto-pauses after a short grace period if all displays close, and **End night**
stops audio and shows **Night not started**.

For an offline UI demo with fake auth and synthetic audio fixtures:

```sh
./scripts/run-dev --dev-auth --fixture-media --data .local/offline-demo
```

## Production

```sh
bun run build
bun start
```

Production requires runtime environment variables and absolute persistent
directories for service and worker data (it never reads `.env.local`). See
[DEPLOYMENT.md](docs/jukebox/DEPLOYMENT.md),
[MONITORING.md](docs/jukebox/MONITORING.md), and
[METRICS.md](docs/jukebox/METRICS.md).

## Verification

```sh
bun run check
uv run --locked python scripts/verify-player.py
uv run --locked python scripts/verify-fades.py
uv run --locked python scripts/verify-admin.py
uv run --locked --group display python scripts/verify-display.py
uv run --locked python scripts/verify-queue-controls.py
```

Build before running the browser verification scripts. Tests use disposable
state, fake auth/media fixtures, fresh Firefox profiles, and null audio sinks.
