# Phase 4A contract proposals (for the integration owner)

Status: **design only. This branch changes no contract, server, core, shared-app, migration, or
package file**, so there is no `contract-proposal:` code commit. Everything below is a request for the
phase-2 integration owner. The admin UI works today without any of it and does not fake support.

## A1. Playlist import (not in contract v1)

The approval plan lists YouTube/Spotify playlist import for admins; v1 has only single-item `master.add`
(playlist/album URLs are rejected as `INVALID_SOURCE`). The admin UI says so and links here.

Proposed, additive:

- `master.import.preview { url }` → `{ title, total, items: [{ index, title, durationSec | null, status: 'ok' | 'unavailable' | 'unsupported' | 'too_long', recordingKey? }] }`.
  Read-only; bounded (suggest ≤ 100 items, one worker call). Role: admin. Not stored for replay beyond its commandId.
- `master.import { url, expectedTotal, selection?: number[] }` → `{ added: string[]; failed: { index; code; message }[] }`.
  One stable `commandId` per import intent. `expectedTotal` guards a playlist that changed between preview and import
  (`REVISION_CONFLICT`-style failure, nothing added). Each item follows `master.add` rules and is added in playlist
  order; a failed item never rolls back the others (partial failure is reported per item). Already-present
  `recordingKey`s are skipped and reported, not duplicated.
- `SourcePort.resolvePlaylist(ref)`: YouTube first via the worker's flat-playlist metadata (bounded subprocess, argument arrays).
  Spotify/Apple playlists stay `SOURCE_UNSUPPORTED` until matching exists; no substitution, no video.
- `canonicalizeUrl` must recognise `youtube.com/playlist?list=` (today: rejected as invalid).
- UI is ready to consume this: a preview list with per-item status and an "Add N of M" confirmation.

Why not implemented here: it changes `src/contract`, `src/core/ports.ts`, `src/server/service.ts`, `validate.ts`, and
the worker; all are integration-owned.

## A2. Findings that affect admin correctness (service side)

1. **SSE keeps the connect-time identity.** An open `/api/v1/stream` continues to receive *admin-scoped* snapshots
   (master list, devices, requester names) after the organizer's session has expired or been revoked, until the stream
   reconnects. Demonstrated by `tests/admin-controls.test.ts` ("known service limitation…"). Suggested fix: re-resolve the
   actor on every push and close the stream (or downgrade the role) when the session is no longer valid. The admin UI
   works around the *UI* side by polling `/api/v1/snapshot` every 4 s, which re-evaluates the cookie.
2. **Player position is not pushed.** Position-only heartbeats do not bump the revision, so SSE is silent while playing.
   The admin extrapolates from `observed.observedAt` and polls every 4 s. If a smoother/cheaper path is wanted: push
   a snapshot (or a small `observed` event) at most every ~5 s while a display holds the lease.
3. **Events carry no actor.** "Changed by someone else" can be detected but not attributed (`events` rows have no
   organizer). Adding `actorName` to events would let the UI say who reordered or skipped.
4. **Unused pairing codes are invisible.** Admins cannot list or cancel an outstanding code (stored hashed,
   10-minute expiry). Acceptable for now; a "pending pairings" view would need a non-secret handle.

## A3. Behavior decisions taken in the UI (no contract change)

- **Removing a playing request** is a queue *and* playback action: it ends the turn (`status: removed`, no refund),
  resumes the suspended mix at its saved position, and starts a fresh master period. The UI warns before sending.
  `playback.skip` on a request has the same effect (`skipped`, no refund).
- **`expectedRevision`** is used only for `night.close` (revision seen when the confirmation opened); everything else
  relies on entry-ID guards, which are not invalidated by unrelated heartbeats. Reorders use relative anchors
  (`afterEntryId`), so concurrent inserts do not invalidate them; a vanished entry/anchor returns `NOT_FOUND`.
- **Retry** is offered only for `retryable` failures and reuses the original `commandId`; deterministic rejections
  (guard/quota/permission) are never retried, the organizer must decide again.
