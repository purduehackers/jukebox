# Phase 2: shared contract, durable service, and scheduling

Implemented 2026-10-30 (America/Indiana/Indianapolis) on `feat/jukebox-state-and-scheduling`,
parent `edea7f8` (phase 1). Scope authority: [APPROVAL-PLAN.md](APPROVAL-PLAN.md).
This is the **stable baseline for phases 3/4A/4B/4C**. The integration owner for
`src/contract/`, `src/server/db.ts` migrations, and `src/server/service.ts` is the
phase-2 owner until integration; later phases propose changes instead of forking them.

Labels used below: **Confirmed** = user decision or approved default. **Implementation
choice** = picked here to fill a gap; recorded so the user can revise it. **Limitation** =
known gap, not hidden.

## What exists

| Piece | Path | Notes |
| --- | --- | --- |
| Shared contract (types, policy constants, errors) | `src/contract/types.ts` | Contract version 1. Commands, results, snapshots, desired/observed playback, events. |
| Runtime validation + role table | `src/contract/validate.ts` | Rejects unknown fields; per-command role enforced server-side. |
| Ports (replaceable boundaries) | `src/core/ports.ts` | `SourcePort` (metadata/matching), `MediaPort` (preparation/cache), `IdentityPort` (PH ID), `Clock`. |
| URL parsing/allowlist | `src/core/sources.ts` | Pure; never fetches. YouTube/youtu.be/music.youtube items, Spotify/Apple Music/Deezer **track** links recognised; playlists/albums rejected. ID-only since 2026-11-14: other query parameters/fragments are discarded; the canonical URL is rebuilt from the validated ID. |
| Durable service | `src/server/service.ts`, `src/server/db.ts` | SQLite (`bun:sqlite`, WAL, `synchronous=full`), versioned migrations (schema 7), single-writer lock file. |
| HTTP transport | `src/server/transport.ts` | Commands, role-scoped snapshots, SSE snapshot stream, auth routes, same-origin media proxy. |
| HTTP routes | `astro.config.mjs` → `src/server/routes/*.ts` | 2026-11-14: the `jukebox-authority` integration injects `/auth/*`, `/api/v1/*`, `/media/*`, `/healthz`, `/readyz`; entrypoints delegate to `transport.handle`. |
| Entry point | `scripts/start-web.ts` (production), `scripts/run-dev` (dev) | Process singleton `src/server/runtime.ts` shared with Astro via `Astro.locals.runtime`; 1 s server-side reconcile timer. |
| Fakes | `src/adapters/fakes.ts` | Fake clock, source catalog, media jobs, identity. No network or credentials. |
| PH ID adapter | `src/adapters/phid.ts` | OIDC code + PKCE against the current `purduehackers/id` provider. Live local sign-in verified 2026-11-02. |
| Worker adapter | `src/adapters/worker.ts` + `jukebox/` | Talks to the private Python worker: `/api/resolve`, `/api/jobs/<id>`, `/api/retention`. |

Runtime (**implementation choice**, updated 2026-11-09): TypeScript run by Bun 1.4.4
(`bun:sqlite`, `node:test` under Bun) inside the Astro standalone server (`@astrojs/node`
adapter); the authority HTTP surface is exposed as injected Astro routes handled by
`src/server/transport.ts` using standard Request/Response. Astro 7 + Vite with Tailwind v4
via `@tailwindcss/vite`; React 19 islands for the interactive UIs. Typechecks: `tsc` plus
`astro check`. The Python worker remains the media boundary; it is not the queue authority.

## Behavior table

Times are server wall-clock epoch ms persisted in SQLite. "Period" = elapsed master period
(15 min production; tests may inject a shorter period via `policy`).

| Situation | Behavior | Status |
| --- | --- | --- |
| First play of a night | Period anchor set at the first `playback.play` (or at `night.open` if master is already playing). | Implementation choice |
| Period elapsed, a **ready** request exists, playing, master is a mix (> 360 s) | Interrupt immediately; save master at last checkpoint, refined by the player's actual paused position (`previous` in its first report for the request load). | Confirmed |
| … master is a normal song (≤ 360 s, including exactly 360 s) | Keep playing; start the request on the song's `ended` report; after the request continue with the *next* master item. | Confirmed |
| … deliberately paused | Stay paused; turn shows `dueReason: 'paused'`; elapsed time keeps running; on organizer resume a mix is interrupted at once and a song finishes first. | Confirmed default |
| Period elapsed, no ready request | Empty turn: re-anchor the period to now, even while paused; no audio change (desired epoch unchanged). | Confirmed |
| Request only `preparing` at the due instant | Treated as empty (only prepared, playable requests count). | **Implementation choice** — revisit if early-turn submissions feel lost |
| Request ends / fails / skipped / removed while playing | Turn finishes: fresh period from now; resume suspended mix at saved position, else next master. Exactly one request per turn. | Confirmed |
| Pause / buffering / player offline | Elapsed time counts. Due transitions are computed server-side even while the player is offline; the player applies them on reconnect. | Confirmed |
| Seek / replay (`seek 0`) | Never moves the period anchor. A late `ended` older than the seek epoch is ignored. | Confirmed / implementation |
| Master `ended` | Advance to next playable master item, looping the list. | Confirmed default |
| Master skip | Advance without resetting the accumulated period. | Confirmed default |
| Master playback error | Reload at last position; after 2 failures the item becomes `unusable` and is skipped forever. | Confirmed default (bounded) |
| No playable master | Pause, `no_master_available` alert; requests are not drained outside their schedule; `play` fails `NOTHING_PLAYABLE`. | Confirmed default |
| Request playback error | One reload at last position; second failure → `failed`, refunded, turn finished. | Confirmed default |
| Night close | Pause; archive the playing request (resume suspended mix, paused) and all waiting requests; close submissions; keep master library; clear period anchor. | Confirmed default |
| Night open | New quota period. No calendar/midnight reset. Master can play outside a night; requests need an open night. | Confirmed / implementation choice |
| Service restart | All state is durable; first reconcile performs any overdue transition from the persisted anchor/checkpoint. | Confirmed |
| Host clock moved backward | Not reconciled (period appears not yet due). | **Limitation** |

## Quota, admission, moderation

- PH ID (or local fake in dev) required for `request.submit`; anonymous → `UNAUTHENTICATED`.
- Validation before reservation: URL allowlist → open night → cheap quota pre-check →
  bounded metadata resolve → strict `< 360 s` → **one transaction** re-checks night, quota
  (3 accepted per identity key per night), and duplicates, then inserts and charges.
  Invalid/unsupported/unavailable/too-long attempts consume nothing. Concurrent submissions at
  the boundary admit exactly one (tested).
- Duplicate = same `recordingKey` (playable recording, not URL text) already `preparing`/`ready`
  in tonight's queue (**implementation choice**: playing/played items are not "waiting").
- Prepared asset duration is authoritative: a request whose validated file is ≥ 360 s fails
  and is refunded.
- Refunds: preparation failure (after 2 attempts for retryable errors) and playback failure.
  No refund: admin `request.remove` (waiting or playing) and `playback.skip`.
- Admission is automatic; FIFO by `order_key`; `request.move {entryId, afterEntryId}` reorders
  relative to entries so concurrent inserts do not invalidate it.

## Commands, responses, retries, concurrency

`POST /api/v1/commands` with `{commandId (UUID), type, payload, expectedRevision?}` →
`{ok, commandId, revision, result, replayed}` or `{ok:false, error:{code, message, retryable}}`.
Types and per-command roles are in `src/contract/`.

- **Stable command IDs.** Final responses (successes and deterministic rejections such as
  `QUOTA_EXCEEDED`, `DUPLICATE_REQUEST`, `GUARD_MISMATCH`) are stored and replayed for the same
  actor + payload; reuse with a different payload or actor → `IDEMPOTENCY_MISMATCH`. Concurrent
  duplicate deliveries execute once. Not stored: `player.report` (idempotent state reports fenced
  by lease/epoch), `device.pair` (its secret token is never persisted; a lost response needs a new
  pairing code), and retryable/`REVISION_CONFLICT`/auth failures.
- **Ordering.** Every mutation is one `begin immediate` SQLite transaction in one process (lock
  file prevents a second service on the same DB). Async work (resolve, preparation, retention)
  runs outside transactions and is re-validated when applied.
- **Guards instead of global CAS.** `playback.skip`/`seek` carry the `entryId` they target
  (two admins skipping together skip once); removes/moves name entries. `expectedRevision` is
  optional strict CAS for clients that want it.
- **Revision.** Global monotonic revision bumps on material changes (not position-only
  heartbeats). Events (`/api/v1/events?after=`, admin) are an audit log keyed by revision.

## Device authority, acknowledgement, reconnect

- **Pairing:** admin `device.pairing.create` → 8-char code, 10 min, single use (stored hashed).
  The display sends `device.pair` and receives a bearer token once (stored hashed). Public
  `/display` rendering without a token gets only the public snapshot. `device.revoke` fences.
- **Lease:** `player.claim` → `{generation, expiresAt}`; 15 s lease renewed by each accepted
  report (expected every 5 s). Another device while live → `LEASE_HELD` (retryable); the same
  device's second tab must pass `takeover: true`, which fences the old tab. Every report must
  match device + generation + live lease or gets `STALE_LEASE`.
- **Desired vs observed:** players reconcile to `snapshot.desired` (`epoch`, `loadId`, asset,
  `startPositionSec`, `seekSeq`, `intent`, `volume`) instead of replaying a command queue.
  Reports carry `{generation, epoch, loadId, status, positionSec, previous?}`. Reports for an old
  `loadId` renew the lease but cause no transitions. Admin sees `playback.confirmation`:
  `requested` (accepted, unacked) → `confirmed` (player acked this epoch) or `unconfirmed` after
  10 s (alert). Accepted ≠ audible: no claim of audible output is made by the server.
- **Reconnect:** fetch `/api/v1/snapshot` or open `/api/v1/stream` (SSE of full role-scoped
  snapshots; on connect the current one is always sent; clients keep the highest revision).
  Reload during a request restores that request (consumed exactly once) with the master still
  suspended and pinned; Firefox may require local activation (`needs_activation` status).
- **Resume tolerance (implementation choice):** interrupt resumes use the actual paused position
  reported by the player; a crash between heartbeats may replay up to ~5 s.

## Cache references

The service computes the full set of assets it needs — current item, suspended mix, every ready
master item, and every ready/playing request — and pushes it to the worker with a monotonic
retention revision (`POST /api/retention`, stale revisions ignored, persisted across worker
restarts). The worker unions it with its phase-1 proof pins for eviction/deletion/reservation.
Pins survive player disconnects; finished/removed items are released. Retaining **all** ready
master items is bounded by the 512 MiB cache budget (**limitation**: large master libraries need
an on-demand re-preparation policy later).

## Auth: PH ID integration status

Inspected `purduehackers/id` at `df68b7a` (2026-10-29): a better-auth `oauthProvider` OIDC
provider. Discovery `https://id.purduehackers.com/api/auth/.well-known/openid-configuration`;
authorization code + PKCE S256; scopes include `openid profile roles`; userinfo returns `sub`,
`preferred_username`/`name`, and `roles` (`alumni`/`organizer`/`admin`, admin ⇒ organizer).
Clients are created by an ID admin in ID's dashboard.

- `PhidIdentity` performs discovery (HTTPS required except loopback tests), PKCE, HMAC-signed
  10-minute login state in an HttpOnly cookie, code exchange, and userinfo (authoritative; the
  id_token is only cross-checked for nonce/sub, not JWKS-verified). Identity key =
  `issuer#sub`. Tested only against an in-process fake OIDC provider.
- **Admin rule (implementation choice, needs confirmation):** PH ID `organizer` or `admin`
  role grants Jukebox admin, plus an explicit allowlist (`--admin-key` / `JUKEBOX_ADMIN_KEYS`).
- **Not done / not claimed:** no Jukebox client is registered with PH ID, no live sign-in has
  been performed, callback URLs for `jukebox.purduehackers.com` are not configured. Sessions are
  server-side (12 h). `--dev-auth` enables a clearly labelled local fake sign-in and refuses to
  run when PH ID env is configured.

## Sources

Spotify/Apple Music track links canonicalise but resolve to `SOURCE_UNSUPPORTED`
("matching is not implemented") — no substitution, no video. YouTube resolution is
metadata-only in the worker (bounded 30 s subprocess, 2 concurrent, argument arrays), then the
phase-1 audio-only preparation applies unchanged. Playlist imports are not implemented.

## Evidence

- `./scripts/check`: 15 Python worker tests, 5 phase-1 policy tests, `tsc` clean, 34 TypeScript
  tests (scheduler 9, accounting/concurrency 10, authority/restart 6, HTTP two-client 1,
  PH ID 5, worker adapter 2 + real-worker integration 1). All deterministic with fake clock and
  adapters; no production credentials or source traffic.
- `node scripts/smoke-service.ts` (2026-10-30): real Python worker + service over HTTP —
  fixture master and request prepared in 7.9 s, player `desired` points at same-origin
  `/media/<id>`, 206 range through the service proxy, worker pins 2/2 queue assets.
- Not exercised in phase 2: Firefox playback against this service (phase 3 player), real
  YouTube resolve through the new endpoint, live PH ID, multi-device over a network, HDMI.

## Limitations and open items

- Single process, loopback-only, no rate limiting, no hardened ingress. Not deployable as is.
- Server wall clock; backward clock jumps are not reconciled.
- The phase-1 diagnostic page (`/display` on the worker) still uses its own proof lease; it is
  not wired to this service. Phase 3 owns the real player.
- Existing-server evaluation, hosting, DNS, audible HDMI/wall checks remain later gates.
- Admin rule and "preparing request at due time counts as empty" are implementation choices
  the user may revise.

## Session/player revision (2026-11-01)

The user's session-driven flow supersedes the pairing UI and music outside a
session above. `night.open` starts the ready master, or durably arms a one-shot
start once a master is prepared. An explicit pause or session end cancels that
pending start. The display clears itself on session end.

New public command `display.connect {secret}` accepts a 256-bit page-specific hex
secret during an open night and atomically registers/claims the player. It cannot
displace a live lease. Same-page retries recover a lost response without fencing
themselves. The response includes device token, generation and expiry; only the
secret hash is persisted, no response token is saved in the command journal.
Automatic registration rows are bounded to the latest automatic player. Player
credentials do not grant attendee/admin actions. Legacy pairing API remains
compatible for service fixtures, but neither UI exposes it. The display's sound
permission is the only local setup step when autoplay is blocked.

Migration 3 appends `devices.automatic` and `playback.autostart`; prior migrations
are unchanged. First connected display is the audio browser; another display
waits for release/expiry. This is a local-first implementation, not a hardened
public deployment.

## Queue playback controls (2026-11-02)

Additive; contract version stays 1. Full rationale: [proposal](proposals/queue-playback-controls.md).

- **Commands (admin only):** `queue.mode {mode: 'auto'|'master'|'requests'}` (absolute, idempotent),
  `queue.interval {periodMs: number | null}` (`null` = default; service bounds 1–120 min),
  `quota.set {enabled: boolean}` (2026-11-14: absolute, idempotent request-quota toggle; when off the
  per-person limit is not enforced but submissions are still counted),
  `request.playNow {entryId}`. New error code `NOT_READY` (request still preparing).
- **Snapshot (`schedule`):** `mode`, `requestsIdle`, effective `periodMs`, `periodDefaultMs`, `periodMinMs`, `periodMaxMs`.
  `turnDue`/`dueReason` are false/null outside `auto`.
- **Migration 4:** `playback.mode` (default `auto`, checked) and `playback.period_ms` (null = default). In-place; a v3
  database keeps queue, quota, lease, suspended mix and period anchor (tested).
- **Migrations 5–7 (2026-11-09/14):** 5 `banned_usernames`, 6 `playback.period_paused_at`,
  7 `playback.quota_enabled` (default 1 = enforced; durable across restarts and nights;
  the snapshot carries top-level `quotaEnabled`).
- **Scheduler:** `requests` mode keeps the master suspended and pinned, chains ready requests, and is silent
  (`phase = request`, no current entry, new load so the player stops) when none is ready; `finishTurn` is the single
  place that chains, idles, resumes, or starts a fresh period (only in `auto`). Closing a night resets the mode before
  archiving, so an idle or playing request never chains past the close.
- **Checkpoint while silent:** with no new load there is no `previous` report, so heartbeats for the suspended master's
  own load update its checkpoint while `requests` is idle (`report()`); the player also sends one immediate report when
  `desired` becomes null (`app/src/player/controller.ts`, transition only). Measured in Firefox: 0.000 s error.

| Situation | Behavior | Status |
| --- | --- | --- |
| `Play now` on a ready request | Cuts in at once (mix or ordinary song), suspends at saved position, resumes after; fresh period in `auto` | Confirmed |
| Switching to `requests` while master plays | Same cut-in; a playing request is never cut off | Confirmed / default |
| `requests`, nothing ready | Silent wait; next ready request starts at once | Confirmed |
| `master` | No automatic turns; timer not running; `Play now` still works | Default |
| Back to `auto` | Fresh interval from that moment, no catch-up turn | Default |
| Interval changed | Applies to the running countdown; already-elapsed with no ready request is an empty turn (re-anchors) | Confirmed |
| Night open/close | Mode resets to `auto`; interval persists | Confirmed |
| `queue.mode`/`queue.interval`/`request.playNow` replays | Stored final response; no re-execution | Existing rule |

The API character bound for submitted links is now 2048 on `master.add`, `request.preview` and `request.submit`
only (previously 300); the source layer's own byte bounds still apply.

## Universal display revision (2026-11-05)

Supersedes the automatic display lease rules above; no migration or new command.
`display.connect {secret}` now works before, during and between nights and returns
report credentials without claiming exclusive playback. Its existing generation
and expiry response fields remain for compatibility; automatic clients do not
use them as playback gates. Up to 32 recent automatic registrations are retained;
accepted reports refresh their recency. Legacy paired-player commands retain their
lease semantics for service fixtures.

An automatic player's snapshot exposes `desired` during an open night without
requiring a lease. Closed nights expose `desired: null`. Initial source position
uses the durable checkpoint unless a newer seek is pending. Automatic reports
are accepted regardless of lease expiry/another automatic tab; load and seek epoch
fences still reject stale transitions. Reports after night close are ignored.
Health expiry marks stale observations, but does not revoke browser playback.
Actual report acknowledgements and stable admin command IDs remain in force.

The display uses one subscription for audio and presentation and cancels obsolete
media operations before publishing the idle state. See
[connection audit](PLAYER-CONNECTION-AUDIT.md) and the player README.

Paused checkpoint clarification: once a paused report applies the current desired
epoch, subsequent paused reports for the same load/epoch renew health without
moving its checkpoint. A seek/new epoch permits the next position. Each native
display presents its own actual audio position; shared observations are the
fallback for read-only fixtures and remain the admin/checkpoint source.

## Organizer-only display revision (2026-11-06)

Supersedes the public command/access descriptions above. Contract version remains
1; no storage migration is required. `display.connect` now requires the `admin`
role. Automatic device credentials additionally require a valid organizer cookie
on every HTTP request. Tokens do not confer organizer commands; their actor
remains `player`. Old anonymously issued automatic tokens cannot be used alone.
The whole display UI and live visualizer lab require organizer access.

SSE credentials are checked before each outgoing snapshot and on the existing
five-second heartbeat. Logout immediately ends affected streams; expiry/revocation
closes them before any further privileged data is emitted. Checks are indexed
local SQLite reads, not identity-provider network requests. Admin/attendee/public
snapshot roles used by other pages remain unchanged. Legacy admin-issued pairing
APIs remain compatible for fixtures; the app uses organizer-authenticated automatic
registration without pairing, exclusive leases or ownership waits.

### Explicit timer pause addition (2026-11-13)

Organizer command `queue.timer: { paused: boolean }` sets the running Auto/master
request timer's pause state independently of audio intent. Snapshot
`schedule.periodPausedAt` is a nullable server timestamp; while set, elapsed timer
time is `periodPausedAt - periodStartedAt`, and automatic turns cannot become due.
Resume shifts `periodStartedAt` by the paused duration. Migration 6 adds nullable
`playback.period_paused_at`; no queue rows or playback checkpoints are replaced.
