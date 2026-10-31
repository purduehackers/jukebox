# Phase 4C: dedicated jukebox display

Status: two independent monitors and Firefox confirmed. Detailed display design
is deferred to its own discussion; implementation uses phase-2 snapshots and may
run alongside player/admin/attendee work after shared contracts are stable.

## Goal

Make Jukebox's dedicated monitor legible and useful. Its `/display` includes the
designated music player. The existing Hack Night dashboard on the other monitor
is a visual reference only; no code, widgets, chat/layout changes, or cross-tab
announcement integration are part of this phase.

## Scope

- Match `DESIGN-REFERENCE.md`: exact dashboard fonts, color roles, borders, and
  dithering settings. Jukebox is a separate repo; the dashboard is the reference.
- Use Jukebox's independent monitor. Confirm its resolution and test Firefox/HDMI
  audio selection when hardware is available; do not redesign the other monitor.
- Place now-playing artwork/title/artist, progress, master versus request status,
  next-slot timer, and QR according to user decisions. Use observed player state;
  show waiting/buffering/offline honestly.
- Display the agreed 15-minute master-playback countdown. One user song plays
  per turn; an empty turn waits a new interval. Include paused/offline/empty states
  without substituting fixed clock slots for the selected playback-time policy.
- Use local fixture snapshots to design the full range of states and unusually
  long titles. Test legibility at the physical viewing distance.
- Confirm Lunar integration mode: separate page, embedded viewer, alternating
  view, or shared layout. Inspect its own instructions before edits and verify
  embedding/origin permissions. Do not merge game scheduling with music scheduling
  merely because both use 15-minute periods.
- Keep a reactive visualizer optional until real audio access is proven. A visual
  animation must not be described as analyzing music if it is decorative.
- Jukebox's own refresh must preserve/recover shared playback state. Do not add
  dashboard refresh regression work or cross-dashboard behavior to this scope.

## Exit gate

Review at actual wall dimensions, scan the QR from a phone, verify audio-only
delivery in Firefox, check long/error/empty states, and test Jukebox refresh and
recovery. Compare its fonts/colors/borders/dithering to the dashboard reference.
Record hardware-only checks still awaiting the venue.
