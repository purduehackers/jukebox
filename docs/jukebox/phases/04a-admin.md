# Phase 4A: organizer controls

Status: can run alongside phases 3, 4B, and 4C after phase-2 contracts are stable.

## Goal

Give organizers a responsive control surface with truthful playback feedback.
Route: intended `/admin` in the separate `purduehackers/jukebox` app.

## Scope

- Real organizer authorization, loading/error/expired-session handling.
- Now-playing item, queue kind, elapsed/remaining position, volume, player online
  status, buffering/errors, and next request-slot state.
- Play/pause, skip, replay, seek, and volume. Distinguish commands in flight from
  changes confirmed by the player. Rapid slider changes should be bounded.
- Add supported tracks to master or user queue; admin duration/quota overrides
  only if explicitly agreed. Do not let attendees gain admin behavior by changing
  a request field.
- Remove and reorder either queue, with stable entry IDs and conflict feedback
  when another organizer changes the queue.
- Import the playlist providers chosen for launch; preview import size and handle
  partial failures. Unsupported providers should be clearly described.
- Moderation, night/session controls, and emergency pause/clear only to the extent
  decided in the discussion. Determine whether removing a playing entry is a
  queue-only action or also a playback action.

## Exit gate

Use the mock service/player first, then the real display. Demonstrate concurrent
organizers, rejected permissions, offline display, failed command, seek/volume,
queue reorder/remove, and playlist partial failure where supported. Mobile
controls should work if organizers will use phones; do not assume desktop-only.

Own admin UI files. Propose contract changes through the integration owner rather
than independently changing the shared schema during parallel implementation.
