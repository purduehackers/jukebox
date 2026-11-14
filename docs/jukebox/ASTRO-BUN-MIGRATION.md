# Astro, Bun and uv migration

Implemented 2026-11-09 from `origin/main` at `e95376c`, on `feat/astro-bun-uv`.
The user approved this migration, retaining React and Python, then added uv.
The rewrite and subsequent local changes are now consolidated on `main`.
This is a source rewrite and deployment package; phack.sh is not deployed.

## Resulting architecture

- Astro serves `/`, `/admin`, `/queue`, `/display`, `/visual`; the `jukebox-authority`
  integration injects `/auth/*`, `/api/v1/*`, `/media/*`, `/healthz` and `/readyz`
  from `astro.config.mjs` to `src/server/routes/*.ts`, which delegate to the transport
  (2026-11-14; previously one-line shims under `src/pages`). Pages use the official PH
  `.astro` components (`src/components/ph/`); React islands ship only for the approved
  controls, player and soundbar. Organizer middleware gates display/lab HTML and shares
  the runtime with routes via `Astro.locals.runtime`.
- Styling is Tailwind v4 through the official `@tailwindcss/vite` plugin (2026-11-14).
  Vite pre-bundles react/react-dom and dedupes React because `@purduehackers/time`
  ships a nested React 18. Dev restarts settle the previous runtime before creating a
  new one, with a SIGTERM/SIGINT shutdown backstop (2026-11-14).
- Bun 1.4.4 runs the production Astro standalone adapter and the SQLite authority.
  The official adapter package is named `@astrojs/node`; no Node executable is
  needed at runtime. Standard Node compatibility imports run under Bun.
- `scripts/start-web.ts` starts scheduling before the first HTTP request. A process
  singleton shares authority with the built Astro handler. Shutdown stops new
  scheduling, closes streams and HTTP, settles work and closes SQLite.
- `src/server/transport.ts` uses standard Request/Response, cancellable SSE and
  streamed audio proxy responses with HEAD/Range support. Existing command IDs,
  local session checks and automatic-player organizer requirements are retained.
- `bun:sqlite` opens existing databases with the same four migrations at migration time; later
  features append migrations 5 (username bans), 6 (request-timer pause timestamp) and 7
  (request-quota toggle `quota_enabled`) — current schema is 7 (2026-11-14). An exclusive
  transaction on a separate lock database prevents concurrent new authorities;
  the OS releases it after SIGKILL, including across container PID reuse.
- Python dependencies are in `pyproject.toml` and `uv.lock`. Worker execution uses
  uv; yt-dlp's JavaScript challenge runtime is Bun. No video fallback is added.
- Development explicitly loads private configuration in the supervisor and skips
  it for explicit test authentication. Astro/Vite implicit env-file loading is
  disabled. The supervised dev CLI uses `--ignore-lock` to keep agent-invoked
  Astro in the foreground; port checks and the authority lock still apply.
- One supervisor owns Astro/Bun and a private uv/Python worker. Production refuses
  another stack's worker on its default port. A child exit terminates the stack
  for external restart. Tini provides container signal forwarding/reaping.
- The Podman image exposes 8080, mounts `/var/lib/jukebox`, and runs as `bun`.
  Host Caddy proxies the whole site. Quadlet supplies reboot/restart/health policy.

The former handwritten Node HTTP listener, SPA routing/static serving, separate
Vite configuration, npm lock and requirements files have been removed. Astro
uses Vite internally for its build/dev pipeline; production serves the built app.

## Verification

- `scripts/check`: 21 Python tests, 192 Bun tests (including five policy tests),
  server/client typechecks, Astro check and production build passed.
- 2026-11-14 rerun on `astro-migration` with the official-component/Tailwind/provider/quota/QR
  changes: 23 Python tests, 220 Bun tests across 33 files (including the policy suite),
  both TypeScript checks, Astro check (0 errors) and the production build passed.
  Browser/HDMI evidence below was not rerun.
- Production Astro + real worker in Firefox 159: all 18 playback/recovery checks
  passed with owned fixture audio, isolated sign-in/state/profiles and a dedicated
  null sink. Includes organizer HTML gate, native autoplay/site permission,
  silent admin/queue, actual FFT response, seek, mix interrupt/resume, normal-song
  boundary, refresh, bounded technical failure/refund, multiple displays,
  short/long outages, five night cycles, logout and exhausted-master silence.
- Development launcher smoke in Firefox passed organizer gating, native autoplay,
  real worker playback, FFT response, silent controls and remote pause/seek/volume.
- Full admin Firefox verification passed, including authorization, controls,
  queue modes/interval persistence, stale reports, 390 px overflow and session expiry.
  The real-audio queue-controls Firefox run passed, including immediate interruption,
  resumed checkpoints, Requests only silence/pinning and a real 60-second interval.
- A database created by the original Node `openDatabase` at `e95376c` reopened
  under Bun with its saved night and schema version 4 intact. A concurrent second
  authority was rejected. SIGKILL released its lock and restart succeeded.
- Actual Podman image built and ran locally with placeholder production PH ID
  configuration and a real worker. Health/readiness, HTML routes, organizer gates
  and unknown API/auth/static 404s passed. Replacement with the same named volume
  preserved the saved night and schema. No identity-provider calls were required.

Compact evidence is in `evidence/astro-bun-*.json`; detailed disposable runs live
under `.local/`. The temporary host toolchain used extracted tools because system
package installation required sudo; container execution used host networking on
isolated test ports. This does not prove the phack.sh port mapping/Caddy setup.

## Local use and operator boundary

Use `bun install --frozen-lockfile`, `uv sync --locked`, then `bun run dev`.
Normal previews require the existing private PH ID configuration and real worker;
fixtures require explicit flags. Fresh worktrees do not contain private config.
Production uses `bun run build` and `bun start` with inherited environment.
See [DEPLOYMENT.md](DEPLOYMENT.md) for Podman, storage, backups and rollback.

Actual phack.sh access, Caddy/DNS, production PH ID login, real-source access from
that network, physical phone QR scan and Firefox/HDMI rehearsal remain operator
checks. Local fixture results do not close those gates. No production state,
credentials, paid infrastructure, DNS or separate dashboard was changed.
