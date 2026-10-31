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
- Begin with the user's `references/display-sketch.png`: main visualizer on the
  left, now-playing/artwork below it, queue sidebar and request QR on the right.
  Discuss proportions, typography, metadata, and transitions before final layout.
- Use Jukebox's independent monitor. Confirm its resolution and test Firefox/HDMI
  audio selection when hardware is available; do not redesign the other monitor.
- Place now-playing artwork/title/artist, progress, master versus request status,
  next-slot timer, and QR according to user decisions. Use observed player state;
  show waiting/buffering/offline honestly.
- Display the agreed 15-minute elapsed master countdown; pauses/buffering count.
  One user song plays
  per turn; an empty turn waits a new interval. Include paused/offline/empty states
  without substituting fixed clock slots for the selected playback-time policy.
- Use local fixture snapshots to design the full range of states and unusually
  long titles. Test legibility at the physical viewing distance.
- Confirm Lunar integration mode: separate page, embedded viewer, alternating
  view, or shared layout. Inspect its own instructions before edits and verify
  embedding/origin permissions. Do not merge game scheduling with music scheduling
  merely because both use 15-minute periods.
- Build a genuine audio-reactive dithered visualization driven by the real playing
  audio. Discuss the listener/analyzer, waveform/frequency features, smoothing,
  geometry, shader, and performance targets in this phase. An idle shader alone
  does not meet the requirement. Use the phase-1 analysis-path proof; if it fails,
  surface the blocker rather than silently replacing audio response with animation.
- Evaluate browser/server responsibilities with the user's existing capable server
  in mind. Do not assume a microphone, a need for new hosting, or server-generated
  video streaming. This is generated visualization of audio, not source-video media.
- Jukebox's own refresh must preserve/recover shared playback state. Do not add
  dashboard refresh regression work or cross-dashboard behavior to this scope.

## Exit gate

Review at actual wall dimensions, scan the QR from a phone, verify audio-only
delivery in Firefox, check long/error/empty states, and test Jukebox refresh and
recovery. Compare its fonts/colors/borders/dithering to the dashboard reference.
Verify that real audio changes affect the visualizer, that it follows master/user
switches correctly, and that pause/silence/seek behavior is intentional. Show the
chosen signal/rendering design to the user in this component discussion.
Record hardware-only checks still awaiting the venue.
