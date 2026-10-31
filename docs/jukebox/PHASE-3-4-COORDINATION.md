# Phases 3 / 4A / 4B / 4C: parallel coordination

Baseline: branch `feat/jukebox-app-shell` (phase-2 service + shared app shell), parent
`feat/jukebox-state-and-scheduling`. Contract: [PHASE-2-CONTRACT.md](PHASE-2-CONTRACT.md).
Integration owner: the phase-2 chat (“Jukebox Phase 2 — Shared state and scheduling”).

## File ownership

| Owner | Files |
| --- | --- |
| Integration owner | `src/contract/`, `src/server/` (incl. `db.ts` migrations), `src/core/`, `app/src/shared/`, `app/src/main.tsx`, `vite.config.ts`, root `package.json`/lock, `scripts/check` |
| Phase 3 player | `app/src/player/`, player browser tests/scripts (e.g. `scripts/verify-player*.py`), the device-pairing/activation UI used by `/display` |
| Phase 4A admin | `app/src/admin/` |
| Phase 4B attendee | `app/src/queue/`; resolver/matching work in new files under `src/adapters/` (e.g. `src/adapters/matching-*.ts`) behind the existing `SourcePort` |
| Phase 4C display | `app/src/display/`, fonts/assets under `app/public/` or `app/src/display/assets/`, visualizer code |

`/display` = `DisplayPage` (4C) composing the player component (phase 3). The player
publishes its `AnalyserNode` through `app/src/shared/audio-tap.ts`; the visualizer
consumes it. Agree any extra player→display surface in a proposal.

## Contract changes

Do not change existing contract semantics, migrations, or shared files in a phase
branch. If a gap blocks you, put the smallest **additive** change in its own commit
titled `contract-proposal: …` with tests, describe it in
`docs/jukebox/proposals/<phase>.md`, and list it in your final report. The integration
owner merges or reworks proposals; parallel branches may need to rebase afterwards.
Adding a dependency to the root `package.json` is a shared change: keep it in that
proposal commit too.

## Routine local loop

- `npm ci`, `./scripts/run-dev` (service on :8980 with fake sign-in, Vite on :5173,
  same-origin proxy). Add `--worker http://127.0.0.1:8971` with `./scripts/run-local`
  running for real audio-only fixture media.
- `./scripts/check` must pass before you report. Use fake clock/adapters for routine
  tests; never require production credentials or source traffic.
- Player SSE needs the device bearer token: `subscribeSnapshots(..., bearer)` uses
  fetch streaming, not `EventSource`.
- Phones cannot reach `127.0.0.1`. Remote-device tests need an approved reachable dev
  address; do not expose the service publicly.
