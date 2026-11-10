# Master/request volume transitions

Requested 2026-11-09. The player changes only the audio element's volume; track
selection, quota, scheduling and source preparation remain server-owned.

## Sequence

- Master → request: master continues playing while volume ramps linearly to zero
  over 7 seconds. Pause it at its actual native position, then keep 3 seconds of
  silence. Start the request at the selected master-volume setting, without a fade.
- Request → master: let the request finish naturally at normal volume. Keep
  3 seconds of silence after its native `ended` event, then resume the master at
  its saved position with volume zero and ramp to the selected volume over 7 seconds.
- Master → master and request → request are ordinary track changes without these
  envelopes. Requests-only mode retains its existing queue behavior.

Ordinary master songs still finish before an automatic request. If a ready request
is already due, their last 7 seconds fade down toward the native end; a request
becoming due later in the tail has only the remaining tail available to fade.
Explicit Play now retains its interruption behavior, including the 7-second fade.
If an outgoing master ends naturally during a fade, the player uses that native
end and does not loop or fabricate additional audio to fill the remainder.

## Controls and recovery

The volume slider sets the base volume. A local fade factor multiplies it, so
changing volume during a fade takes effect without restarting its progress.
Pause, seek, skip, End night, logout and page disposal cancel pending local work;
a cancelled operation cannot start playing later. End night still stops immediately.
The request has no fade-out. Media preparation/metadata/seek can run during the
silent interval, but playback cannot begin before the gap ends. Slow preparation
may extend silence; the gap never forces unready media to play.

The master checkpoint includes the 7 seconds that actually played during fade-out.
It is sent through the existing `previous` report field. Heartbeats keep running
during fades and silent waits without reporting an unseeked transient zero as a
checkpoint. The suspended master's asset stays pinned by the existing authority.

Transitions are per-browser volume envelopes, with no exclusive player lease.
Reload reconnects to the authoritative current track/checkpoint; it does not
replay the old page's local timers. Multiple display tabs remain independently
playable as previously approved. Scheduling time still uses elapsed wall time.

## Verification

`tests/volume-transition.test.ts` uses a manual clock for production 7,000/3,000 ms
constants, base-volume changes, silence deadlines and cancellation.
`tests/player-lifecycle.test.ts` exercises the real controller/service boundary,
exact interrupted position, ordinary-song tail, pause and night-close cancellation.
`uv run --locked python scripts/verify-fades.py` verifies the production build in
real Firefox with the real worker's synthetic audio and disposable identity/state.
Detailed local evidence is under `.local/`; compact verified evidence is archived
under `docs/jukebox/evidence/`. These checks do not verify audible HDMI or venue output.
