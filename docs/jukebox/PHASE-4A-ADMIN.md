# Phase 4A: organizer controls (`/admin`)

Implemented 2026-10-30 on `feat/jukebox-admin` (parent `feat/jukebox-app-shell` @ `c2dc883`). Files are all under
`app/src/admin/` plus `tests/admin-*.test.ts`, `scripts/verify-admin.py`, and this/proposal docs.
Contract proposals and service findings: [proposals/phase-4a.md](proposals/phase-4a.md).

## Structure

| File | Responsibility |
| --- | --- |
| `app/src/admin/derive.ts` | Pure view-model: position estimate, request-turn description, player/confirmation labels, move anchors, error explanations. |
| `app/src/admin/intents.ts` | `CommandRunner` (one `commandId` per user intent, same-ID retry, per-intent status) and `VolumeController` (≤1 in flight, ≥250 ms apart, last value always sent). |
| `app/src/admin/state.ts` | `useLive` (SSE + 4 s poll, access gate, connection state, external-change detection), `useControls`. |
| `app/src/admin/views.tsx`, `AdminPage.tsx`, `admin.css` | Presentational panels, composition, dashboard-token styling (phone first). |

## Behavior

- **Access:** `/auth/login` (fake sign-in locally). Signed out → sign-in; signed in without organizer → "Organizer access required";
  an expired session after having been admin → "Session expired". Server enforcement is authoritative; the UI only reflects it.
- **Honesty:** now-playing shows server *intent*, then `Requested` → `Confirmed by display` / `Unconfirmed`, and the display state
  (none, needs activation, loading, playing, paused, buffering, error, offline). Position is extrapolated only from a confirmed, playing report and is labelled
  stale/unconfirmed/unknown otherwise. "Confirmed" explicitly does not mean audible in the room.
- **Next request turn:** from `periodStartedAt`/`periodMs`/`serverTime` only: period countdown, ready/preparing counts, mix-vs-song consequence,
  paused/offline/due/empty explanations. No exact request start time is invented.
- **Controls:** play/pause, replay (seek 0), ±15 s, seek slider (commit on release, guarded by `entryId`), skip (confirm), volume (bounded traffic),
  night open/close (confirm; close uses `expectedRevision`), master add, remove/reorder both queues (↑/↓ anchors, confirm on remove), pairing code, revoke.
- **Unsupported:** Spotify/Apple links and playlists are described as unsupported in the add form and in error text; nothing is substituted.
- **Conflicts:** guard/`NOT_FOUND`/`REVISION_CONFLICT` show as "not applied" with an explanation; a queue change not caused by this tab shows a dismissible banner.

## Verification

- `tests/admin-controls.test.ts`: real HTTP service, fake clock/adapters/display — racing organizers, replay/IDEMPOTENCY, permissions and expiry,
  requested/unconfirmed/confirmed/offline, seek/replay/volume (50 slider values → 2 commands), reorder/remove both queues incl. removing the playing request,
  strict-revision night close, lost-response retry through the real `sendCommand`, turn descriptions, SSE-after-expiry limitation.
- `tests/admin-render.test.ts`: real TSX views server-rendered through Vite SSR from live-service snapshots.
- `scripts/verify-admin.py`: headless **Firefox** against service + Vite (390 px phone viewport, real clicks).
- Not covered: the real phase-3 player, real PH ID, real media worker, a physical phone, HDMI. Chromium preview is not Firefox evidence.
