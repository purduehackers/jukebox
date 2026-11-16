# Sentry monitoring

Jukebox can report errors to Sentry from all three runtime pieces with a single
DSN. Monitoring is **opt-in**: when `JUKEBOX_SENTRY_DSN` is unset or blank, every
helper is a no-op, so local tests, fixture runs and fresh checkouts never send
events.

## Configuration

One env var, read at process start / page-request time (never a build argument):

| Variable | Used by | Meaning |
| --- | --- | --- |
| `JUKEBOX_SENTRY_DSN` | web authority, browser pages, audio worker | Sentry DSN (client key) of the project |
| `JUKEBOX_SENTRY_ENVIRONMENT` | all three | environment tag; defaults to `production` when `NODE_ENV=production`, else `development` |
| `JUKEBOX_SENTRY_RELEASE` | all three | optional release tag |
| `JUKEBOX_SENTRY_TRACES_SAMPLE_RATE` | all three | 0–1; `0` (default) sends errors only, no performance traces |

A browser DSN is public by design. Pages receive it at request time through
`data-sentry-*` attributes on `<html>` (`src/layouts/Page.astro`), so the same
server env var covers the client without build-time plumbing; a build-time
`VITE_SENTRY_DSN` / `VITE_SENTRY_RELEASE` / `VITE_SENTRY_TRACES_SAMPLE_RATE`
overrides it when present.

Set the DSN in `.env.local` for development or in the private env file for
production (see `deploy/jukebox.env.example`). In development `scripts/launch.ts`
copies `JUKEBOX_*` keys from `.env.local` into both child processes, so one line
covers the authority, the pages and the worker.

## What is captured

- **Web authority (Bun/Astro, `@sentry/bun`):** unhandled exceptions and promise
  rejections via the default `OnUncaughtException`/`OnUnhandledRejection`
  integrations (verified on Bun 1.4.4 without build-time instrumentation), plus
  explicit captures for authority request failures (`transport.handle` 500s),
  page/middleware errors, and the scheduler reconcile loop
  (`src/server/monitoring.ts`). The supervisor (`scripts/launch.ts`) also
  initializes monitoring. No build-time Sentry plugin is needed at the default
  traces rate of 0; the orchestrion transform would only add APM spans.
- **Browser pages (`@sentry/react`):** errors on `/admin`, `/queue`, `/display`,
  `/visual`, initialized from the `data-sentry-*` attributes in
  `src/shared/monitoring-client.ts`. `BrowserTracing` is only added when a
  traces rate is configured. Sentry v11 sends no PII by default.
- **Audio worker (Python `sentry-sdk`):** unhandled exceptions, including
  handler-thread crashes via `handle_error` and thread exceptions via the
  default threading integration (`jukebox/monitoring.py`).

## Project (2026-11-16)

The project is `jukebox` in the `purduehackers` Sentry org (team `jukebox`).
Project creation through the API is disabled for members in that org
("Your organization has disabled this feature for members"), so it was created
manually on 2026-11-16; its DSN lives only in the private env files
(`.env.local` locally, the deploy env file in production) and is never
committed. Wiring was verified end-to-end with a one-off smoke event
(issue `JUKEBOX-1`, ignored after confirmation).

To verify the wiring without polluting a real project, point
`JUKEBOX_SENTRY_DSN` at the org's ingest URL with a nonexistent project id: the
SDK initializes, events are captured, and delivery attempts fail with HTTP
400/404 while nothing lands in any project.

## Releases and source maps (CI)

The `publish-container` workflow passes `SENTRY_RELEASE=sha-<git sha>` as a build
arg, and the Containerfile bakes it into the image as `JUKEBOX_SENTRY_RELEASE`,
so production events carry the release matching the `sha-<git sha>` image tag (an
operator env value overrides it). The same workflow, when the repo secret
`SENTRY_AUTH_TOKEN` holds a Sentry auth token with the `org:ci` scope, builds the
app in the runner and uploads the `dist` source maps plus a release with
`@sentry/cli` (`releases new` / `sourcemaps inject` / `sourcemaps upload` /
`releases finalize`). Source maps are enabled in `astro.config.mjs`; the repo is
public, so shipping them in the image exposes nothing. Without the secret, the
step skips gracefully and the image is unchanged apart from the release env.

## Tests

`tests/monitoring.test.ts` and `tests/test_monitoring.py` cover the disabled
default and config parsing; they never initialize a real client. Because Bun
auto-loads `.env.local` into `bun test`, the test scripts run with
`--preload ./tests/preload.ts`, which strips every Sentry env var so the suite
can never send events even when a DSN is configured locally.
