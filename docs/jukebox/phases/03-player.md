# Phase 3: designated playback browser

Status: depends on phases 1 and 2. May overlap stage-4 UI work after contracts land.

## Goal

Make the display laptop execute authorized remote control reliably, with a small
functional display before visual polish.

## Work

- Enroll/pair the playback device and obtain its active lease. Bind commands and
  reports to the active generation. Opening another display must not automatically
  produce another venue player.
- Implement the phase-1 adapter against phase-2 commands and snapshots. Report
  actual provider state, position, errors, and heartbeat with bounded frequency.
- Use native browser audio with prepared audio-only assets; no video element,
  embedded video player, or video-media fallback. Preserve suspended master cache
  references while requested music plays.
- Support play/pause, seek, replay, skip, and volume with explicit capability and
  acknowledgement handling. Browser volume is distinct from OS/HDMI volume.
- Persist and restore the master checkpoint across request playback, respecting
  the agreed skip, pause, failure, and scheduling behavior.
- Provide a local startup/activate-audio action when needed. Remote admin clicks
  cannot be assumed to satisfy the display browser's autoplay restrictions.
- Define loading timeouts, bounded retries, and fallback to master or silence
  according to policy. Do not consume user allowance or mark a song played merely
  because loading was requested.
- Handle socket loss, stale commands, lease loss, page reload, laptop sleep, and
  takeover. A stale player must stop audio when its authority expires; service
  fencing alone cannot silence a disconnected browser.
- If the accepted offline policy permits playback, define its lease/ownership
  consequences explicitly to prevent overlap with a replacement device.

## Exit gate

From a separate profile/device, an admin can control the designated display while
admin and attendee clients remain silent. Demonstrate a complete interrupt/resume
cycle, provider failure, refresh, reconnect, and a second display opening without
duplicate authorized playback. Record measured command latency and wall/HDMI
observations. Test takeover only with the agreed safety/continuity policy.
