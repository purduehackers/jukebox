# Proposal: queue playback controls and request interval

Branch `feat/jukebox-queue-playback-controls`, baseline `f9de59b`. Written 2026-11-02 for the
integration owner (coordinator `mcp:14aa214f-…`) **before** implementation; **approved by the integration owner and implemented as
written**, plus the additions in "Implementation notes" at the end. Everything here is
additive to contract version 1; no existing command, field, or migration changes meaning.

Labels: **Confirmed** = the user answered it in this chat. **Default** = my choice to fill a gap;
open to revision. **Limitation** = known gap.

## Product behavior

Three controls, all authoritative in the service (nothing is a browser timer or browser state):

| Control | Behavior | Status |
| --- | --- | --- |
| **Mode** `auto` / `master` / `requests` | One shared setting. `auto` is today's behavior and the default. | Labels are a proposal; the three-way choice was requested |
| **Play now** (per ready request row) | Starts that request immediately, interrupting whatever master item is playing, **including an ordinary song**. The interrupted item is suspended at its position and resumes there when the request ends. | **Confirmed**: explicit admin actions cut in immediately |
| **Request interval** (minutes) | Length of the master period. Default 15. Stored in the service. | Control requested; default 15 unchanged |

### Mode semantics

| Mode | Master | Requests | Timer |
| --- | --- | --- | --- |
| `auto` | Plays; interrupted by the automatic turn (song finishes, mix is cut in), exactly one request per turn | One per turn | Existing rules, unchanged |
| `master` | Plays and loops as usual | Wait in the queue; no automatic turns. `Play now` still works as a one-off. | Not running (`periodStartedAt = null`) |
| `requests` | Suspended at its saved position (pinned) and resumed when you leave this mode | Play back to back, in queue order, with no 15-minute gaps | Not running |

- **Requests only, nothing ready: wait silently** (Confirmed). Phase is `request`, `nowPlaying` is
  null, the suspended master stays pinned, and the next request that becomes ready starts at once.
- **Switching to `requests` while master plays** cuts in immediately (Confirmed), like `Play now`.
  If a request is already playing it is **not** cut off (Default: skipping loses the requester's
  song without a refund); it finishes and the chain continues.
- **Leaving `requests`** while idle resumes the suspended master at its saved position. While a request is
  playing, the request finishes first and then master resumes (Default).
- **Switching to `master` while a request plays**: the request finishes, then master resumes
  and no further turns happen (Default).
- **Switching back to `auto`** starts a **fresh** interval from that moment, with no immediate catch-up
  turn, so a long `master` stretch cannot unleash a backlog (Default). `Play now` is the way to
  take a turn immediately.
- **Exactly-one-request-per-turn** remains the rule for `auto`. `requests` is an explicit
  organizer override that intentionally plays several in a row.
- **Play now** is rejected while another request is playing (`GUARD_MISMATCH`; reorder the queue
  instead) and for a request still preparing (`NOT_READY`). If the master is paused (deliberate
  pause) the request loads but stays paused until Play (Default: pause authority is not overridden).
- After a `Play now` request ends in `auto`, the usual fresh 15-minute (or configured) period starts and the
  suspended master resumes at its saved position.
- Accounting is untouched: `Play now` and mode changes never change allowance. Technical playback
  failures still refund; admin skip/remove still do not.

### Interval semantics

- Stored override, in whole milliseconds, bounded **1 to 120 minutes** by the service
  (`policy.periodMinMs` / `periodMaxMs`); `null` clears the override back to the default (15 min).
- **Applies to the running countdown** (Confirmed): `due = periodStartedAt + newPeriod`. Shortening
  below the elapsed time makes the turn due immediately (mix is cut in; a song finishes first),
  or, if no request is ready, is an empty turn that re-anchors to now, as today. Lengthening
  extends the countdown. The admin UI warns before saving a value that is already elapsed.
- The first-order rule "elapsed time counts through pause/buffering; seeking never moves the
  anchor" is unchanged.

### Persistence and night reset

- Mode and interval are SQLite columns in the singleton `playback` row, written in the same
  transaction as every other playback change, so they survive restarts and are identical for
  concurrent admins (last absolute write wins; both commands are idempotent per stable command ID).
- **Mode resets to `auto` on `night.open` and `night.close`** (Confirmed); the pending suspended master
  is resumed by the existing close path. **The interval persists** across nights (Confirmed).

## Contract changes (`src/contract/types.ts`, `validate.ts`)

```ts
export type QueueMode = 'auto' | 'master' | 'requests';

// POLICY (additive)
periodMinMs: 60_000, periodMaxMs: 120 * 60_000,

// CommandPayloads (additive; all admin-only)
'queue.mode': { mode: QueueMode };                 // absolute, idempotent set
'queue.interval': { periodMs: number | null };     // null = back to default
'request.playNow': { entryId: string };            // guarded by entry id

// ErrorCode (additive)
| 'NOT_READY'

// Snapshot.schedule (additive, public-safe: display and /queue need it)
mode: QueueMode;
periodMs: number;            // existing field, now the *effective* interval
periodDefaultMs: number;     // lets the UI show/reset "default"
periodMinMs: number; periodMaxMs: number;
requestsIdle: boolean;       // mode === 'requests' and nothing playing
// turnDue / dueReason are false / null outside `auto`.
```

`playback.volume`, `night.*`, and every other command are unchanged. Commands keep the existing stable-ID
journal, role table (`COMMAND_ROLES`), strict unknown-field rejection, and per-command transaction.
`CONTRACT_VERSION` stays 1 (additive fields; old clients ignore them). Fixtures that build a
`Snapshot` literal gain the new `schedule` fields (display fixtures, tests).

## Migration (append-only, number 4)

```sql
alter table playback add column mode text not null default 'auto'
  check(mode in ('auto','master','requests'));
alter table playback add column period_ms integer;   -- null = policy default
```

Existing rows get `auto` / default, i.e. the current behavior. No data rewrite and no table rebuild.
The generic `savePlayback` already writes any new columns. Test: a v3 database upgrades in place
and keeps its queue, suspended mix, quota, and period anchor.

## Scheduler changes (`src/server/service.ts`)

- `periodDue` and the snapshot's `turnDue` additionally require `mode === 'auto'`.
- `effective period = pb.period_ms ?? policy.periodMs` used by `periodDue`, `schedule()`, snapshot.
- `startRequest` keeps suspending exactly as today; `queue.mode → requests` and `request.playNow`
  reuse it (and the same `{itemId, positionSec, loadId}` shape so the player's first-report
  `previous` position still refines the saved position).
- `finishTurn`: in `requests` mode with an open night it starts the next ready request, or goes idle
  (keeps the suspended master, `current_id = null`, new load so the player stops) instead of resuming;
  the fresh period is only set in `auto`.
- `schedule()` starts a ready request when `requests` mode is idle (covers a request that finishes
  preparing later, and a service restart).
- `night.open`/`night.close` reset the mode to `auto` before their existing logic; `play` only anchors
  a period in `auto`.
- Every transition is inside the existing `begin immediate` transaction; async preparation is untouched.
  Master pinning: the suspended mix's asset is already in `retentionSet()`; idle `requests` keeps it pinned.

## Admin UI (`app/src/admin`)

Inside the Now-playing panel, below the transport and above the turn line:
1. **Mode selector**: a three-button group. Choosing `Requests only` while music is playing asks for
   a two-step confirm that names what gets interrupted and where it will resume.
2. **Turn line** becomes mode-aware: `Master only: request turns are off`, `Requests only: waiting
   for requests` / `N waiting`, or today's countdown.
3. **Interval**: a minutes field with `Set`, `Use 15 min`, and an elapsed-time warning.
4. **Request rows**: `Play now…` (two-step confirm naming the interrupted item and resume position),
   disabled with a reason when a request is playing or the row is still loading.
All use the existing intent/command runner (stable command IDs, optimistic state that rolls back).

## Shared files touched outside the admin (minimal, for review)

| File | Change | Owner note |
| --- | --- | --- |
| `app/src/display/model.ts` | Countdown reads `schedule.mode`; hides it outside `auto`. | Display is otherwise untouched |
| `app/src/display/fixtures.ts` | Add the new `schedule` fields. | Fixture only |
| `app/src/queue/model.ts` | `estimateTurn` returns a mode-aware kind outside `auto`. | Link workstream owns `app/src/queue` messaging; I touch only this function and will report the diff |
| `src/server/main.ts`, validators, worker, providers | **Not touched.** | Link workstream |

## Verification plan

Deterministic fake-clock tests for: mode matrix, `Play now` on mix and ordinary song with exact resume
position, chained requests, idle-then-ready, leaving each mode, interval shorten/lengthen/empty-queue,
night resets, restart persistence, v3 → v4 migration, concurrent admins, replayed command IDs, refunds
and one-per-turn in `auto`. Admin render tests; real Firefox desktop and 390 px admin checks via
`scripts/verify-admin.py` on isolated ports. Audible HDMI output is not claimed.

## Implementation notes (added after approval)

- **Checkpoint while silent** (integration check): entering `requests` with nothing ready sends no new load, so the player's
  `previous` position is never reported. The service now also takes the position from heartbeats for the *suspended master's own load*
  while idle, and the player sends one immediate report when `desired` becomes null (transition only; `report()` refreshes the
  snapshot, so reporting on every null `desired` would loop). Firefox: checkpoint error 0.000 s across three idle durations (1.2, 7, 2.6 s).
- **Link bound**: `str(300)` is now `str(2048)` (`MAX_URL`) on `master.add`, `request.preview`, `request.submit` only.
- **Shared-file diffs** outside the admin: `app/src/display/model.ts` (mode-aware turn text, interval from the snapshot),
  `app/src/display/fixtures.ts`, `app/src/queue/model.ts` (`NOT_READY` copy; `estimateTurn` returns `master-only`/`requests-only`;
  `describeEstimate` cases), `app/src/player/controller.ts` (one transition report), `tests/queue-model.test.ts` (schedule literal).
  Integration updates `/queue` footer copy to follow the configured mode/interval; the not-started message no longer assumes 15 minutes.
- `scripts/verify-queue-controls.py` is new; `scripts/verify-admin.py` gained queue-control checks and a mobile controls screenshot.
