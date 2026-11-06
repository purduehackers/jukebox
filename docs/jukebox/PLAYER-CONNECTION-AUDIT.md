# Display / admin / player audit — 2026-11-05

## Confirmed behavior

The user confirmed automatic start/stop and checkpoint resume. `/display` stays
connected while idle. With no night it is silent and shows **Night not started**.
**Start night** starts the prepared master automatically; preparation completes
into playback if needed. **End night** cancels outstanding playback and returns
to idle. Reloads resume the current track near its saved position. Two display
tabs may both play. There is no pairing, linking, app sound-enable button, or
exclusive player selection.

The control server can remain available continuously. The open display tab
produces HDMI audio; a closed tab cannot. Firefox's persistent site permission
(**Autoplay → Allow Audio and Video**) allows unattended reloads and future
nights. The app attempts native playback automatically and only explains a real
browser block. A webpage cannot set or override that browser permission.

## Findings and changes

| Finding | Effect | Resolution |
| --- | --- | --- |
| Every successful connection waited a full 15-second lease | Healthy starts/reloads appeared broken | Automatic displays have no ownership wait or exclusive lease |
| Connection was tied to an open night | Each night introduced another claim/recovery cycle | Connect on page load and retain credentials across nights |
| Screen and audio had independent state subscriptions | Visual state and sound could disagree; a special cross-feed stop workaround was needed | One ordered subscription drives both; stop is applied before publishing idle |
| An app activation flag gated native `play()` | A suspended analyser could prevent any native autoplay attempt; setup UI appeared before a real playback block | Always attempt native playback; use saved Firefox site permission |
| In-flight metadata/seek/play could outlive a new intent | Delayed starts, slow skips, or obsolete operations treated as failures | Cancel superseded operations and reconcile the latest intent; night end cancels immediately |
| Reconnect/refresh used old load-start positions | A reload could jump far behind the last played position | Automatic player snapshots start from durable actual checkpoints |
| Old seek reports could update checkpoint/terminal state | A late pre-seek report could rewind or advance playback incorrectly | Reject reports older than the explicit seek epoch |
| Exclusive ownership expired during network loss | Buffered music stopped after an arbitrary 15 seconds | Health timestamps describe observation freshness; they do not revoke automatic playback |
| SSE retained long reconnect backoff after HTTP recovered | Controls could take another polling interval after a restart | A successful snapshot poll expedites stream reconnection |
| Controller checked ownership/reconciliation ten times per second | Unnecessary idle work | One-second playback retry timer; ordinary commands reconcile on incoming state |
| Closed nights still waited for playback acknowledgements | Idle admin could show a spinner and offline/unconfirmed alerts for music deliberately stopped | Closed-night snapshots carry no pending playback confirmation or playback health alerts |
| Refresh created/replaced the sole automatic device | Repeated connections invalidated other pages | Keep a bounded set of 32 recent automatic report credentials |

Server scheduling, durable queue state, PH ID, media cache pinning, bounded error
retries, technical-failure refunds, stable command IDs and actual browser
acknowledgements remain. Old paired-device APIs remain compatible for the existing
service fixtures; the application no longer uses them. No database migration is
needed. The shared contract revision is recorded in PHASE-2-CONTRACT.md.

## Recovery limits

A disconnected tab continues its current buffered audio, but cannot receive
remote pause/end/skip until the service connection recovers. A reload resumes
from the last stored checkpoint, usually within one five-second report interval;
unload checkpoint delivery is best effort. A browser/site permission reset can
block autoplay again. Physical sound routing, laptop sleep/wake and a whole-night
venue rehearsal require the actual laptop and HDMI setup.

## Verification

- Controller/service regressions cover repeated nights, cancellation during load,
  pause racing load, native autoplay denial/recovery and volume without reload.
- Service regressions cover independent automatic displays, expiry/restart
  recovery, bounded registrations, reload checkpoints and stale seek reports.
- Firefox workflows use isolated local service/worker data and real synthetic
  audio assets. The player workflow first verifies Firefox's default block, then
  saves a site permission once. It exercises actual audio analysis, silent remote
  controls, seeking, request/resume, reload, failures/refunds, concurrent displays,
  outages and repeated nights. No global autoplay preference is changed.
- Display and queue-control workflows verify real analysis, layout/QR behavior and
  exact suspended-master checkpoints. Audio output uses owned null sinks; these
  tests do not establish audible HDMI output.

Results: `./scripts/check` passed 21 Python worker tests, five policy tests,
173 TypeScript tests, both TypeScript checks and the production app build.
Firefox 159.0 passed all 16 player checks, 15 display checks and five queue-control
checks. Five successive night starts reached playback in 244–325 ms in the
isolated run. Master interruption/resume and requests-only idle/resume measured
0.000 seconds of seek error. These are local measurements, not venue guarantees.

The actual `scripts/run-dev --worker` path also passed its isolated Firefox smoke
check after the final checkpoint fixes. The existing normal app was restarted
from this worktree on ports 5173/8980/8971 with its original saved service data,
PH ID mode and real worker. All health/page checks passed and the existing open
night was preserved. No production deployment or venue audio check was performed.

## Paused clock correction

Live sampling reproduced alternating reports from two automatic displays at
295.179 and 318.622 seconds, both paused on the same load and epoch. Last-writer
position reporting made the shared display clock flicker. The native player's
position/status now drives its own display (including the visualizer's position
reference); stale local load/epoch data cannot describe another track or seek.
Native time updates do not create extra HTTP reports. The server fixes the paused
checkpoint after the first applied pause report for that epoch; repeated paused
heartbeats cannot move it, while an explicit seek/new intent permits a new value.
Neither behavior restricts concurrent playback or adds a setup step.

The second live instance was the agent's T3 preview alongside the user's single
Firefox tab; it was explicitly closed. The isolated Firefox 159 regression kept
two native players paused at 04:55 and 05:18 for 16 consecutive samples across
alternating heartbeats: neither local clock nor the shared checkpoint moved.
`./scripts/check` then passed 177 TypeScript tests, 21 Python tests, five policy
tests, both TypeScript checks and the production build.
