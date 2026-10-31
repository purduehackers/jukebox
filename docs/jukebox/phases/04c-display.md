# Phase 4C: wall display and dashboard integration

Status: wireframes may start after layout answers; implementation uses phase-2
snapshots and may run alongside player/admin/attendee work.

## Goal

Make the wall legible and useful while preserving existing Hack Night behavior.
The jukebox `/display` includes the designated player; any extra dashboard
now-playing widget is read-only.

## Scope

- Match `DESIGN-REFERENCE.md`: exact dashboard fonts, color roles, borders, and
  dithering settings. Jukebox is a separate repo; the dashboard is the reference.
- Confirm real screen geometry and how two browser views remain visible. Document
  windows/fullscreen/kiosk placement and HDMI audio selection.
- Place now-playing artwork/title/artist, progress, master versus request status,
  next-slot timer, and QR according to user decisions. Use observed player state;
  show waiting/buffering/offline honestly.
- Define what the countdown means under fixed slots versus playback-time policy,
  including an empty queue and a disconnected player.
- Use local fixture snapshots to design the full range of states and unusually
  long titles. Test legibility at the physical viewing distance.
- Confirm Lunar integration mode: separate page, embedded viewer, alternating
  view, or shared layout. Inspect its own instructions before edits and verify
  embedding/origin permissions. Do not merge game scheduling with music scheduling
  merely because both use 15-minute periods.
- Decide announcement behavior before adding pause/duck signaling across origins.
  Existing React context is local to the dashboard. Cross-tab signaling should
  use an authenticated, scoped shared event path if needed, with expiry so a lost
  “announcement ended” event does not leave music permanently paused.
- Keep a reactive visualizer optional until real audio access is proven. A visual
  animation must not be described as analyzing music if it is decorative.
- Preserve Edge Config refresh client state, Discord feed, clocks, overlays,
  and midnight behavior. New jukebox state should not reset on routine refresh.

## Exit gate

Review at actual wall dimensions, scan the QR from a phone, verify audio-only
delivery, check long/error/empty states, and test dashboard refresh plus midnight
or announcement interactions. Run existing dashboard regression checks for any
integration changes. Record hardware-only checks still awaiting the venue.
