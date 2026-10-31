# Phase 3: designated Firefox playback browser

Implemented 2026-10-30 (America/Indiana/Indianapolis), based on app-shell baseline
`c2dc8835241753784e27614592cade1255ebe570`. Scope authority remains
[APPROVAL-PLAN.md](APPROVAL-PLAN.md). No production deployment or venue test is claimed.

## Implementation

`app/src/player/Player.tsx` provides pairing, explicit claim/same-device takeover,
local activation, and one audio element. `controller.ts` reconciles complete desired
snapshots by epoch, load ID, seek sequence, intent and browser volume. It does not
schedule requests or interpret source URLs. The phase-4C placeholder currently
composes `<Player />`; the final display should compose it exactly once.

The native audio element feeds MediaElementAudioSourceNode → AnalyserNode →
destination. The analyser is published through the unchanged shared audio-tap
boundary. Paused/inactive players publish null. Admin and attendee pages have no
media elements. No video element, embed or video fallback was added.

Pairing persists locally; authority and activation do not. Reports carry actual
status/position and applied epoch/load, with the prior load's actual paused
position on transition. A heartbeat runs every five seconds, with immediate
reports after transitions; reports that overlap queue another report. After a
terminal acknowledgement, silent heartbeats continue without replaying the
terminal event. Native ended
and load errors drive the service's completion/refund/retry rules. Load, seek and
play waits are individually bounded to eight seconds. All successful claims wait
15 seconds before audio, with reports renewing authority during that wait.

This wait is a **conservative implementation choice**, not a changed server
contract: even an ordinary claim can follow admin revocation of a disconnected
browser whose local lease has not expired. Waiting a full lease prevents a new
browser starting during that interval. Same-device takeover is explicit; another
device cannot steal a live lease. Every document still requires local activation.

Local authority deadlines use monotonic and wall time from the start of each
accepted claim/report request. SSE generation changes, rejected stale reports,
revocation/authentication errors and the independent 100 ms lease watchdog silence
local playback. Delayed snapshots older than the successful claim/latest snapshot
are ignored across SSE and fetch. Page exit attempts a final paused checkpoint,
then release, via keepalive requests; expiry remains the fallback.

## Verification and reproduction

- `./scripts/check`: Python worker tests, policy/service tests, both TypeScript
  projects, browser build, and HTTP/worker integration checks.
- `.venv/bin/python scripts/verify-player.py`: fresh headless Firefox profiles,
  actual Python-worker audio fixtures, dedicated silent PulseAudio sink, production 15-second lease/five-second
  heartbeat, isolated SQLite service, loopback-only test scheduling endpoint.
- `.venv/bin/python scripts/verify-player.py --dev-smoke --output .local/player-dev-firefox.json`:
  actual `./scripts/run-dev --worker …` path and unmodified production service.

The verifier routes its owned Firefox processes with `PULSE_SINK`, verifies the
player stream on that dedicated null sink, and unloads the sink after browser
cleanup. It does not change the system default output. Earlier headless runs
reached the developer speakers (reported by the user); those runs were stopped
and final evidence uses silent routing. This is not venue/HDMI validation.

The full verifier advances only the master period anchor, rather than waiting
15 minutes. It uses the real hour-long Opus fixture and four/eight-second request
fixtures, seeks past twenty minutes, and allows native ended to complete requests.
The normal-song case seeks near the end of an exactly-six-minute asset. Its failure
case temporarily removes a prepared worker file before the first browser load,
observes both permitted failed loads, and checks the refund and return to master.

Coverage includes initial silence and local activation, separate signed-in admin
and attendee profiles, pause/seek/volume/play, real analyser samples across loads,
pinned suspended mix, exactly one request then precise resume, normal song end,
mid-request reload without a second quota charge, short restart/reconnect without
another load, socket loss beyond lease expiry, competing tab/device, explicit
same-device takeover, delayed pre-claim snapshot, stale report rejection, and
forget/re-pair with a fresh Web Audio binding, and master exhaustion retaining a
silent lease beyond 15 seconds without repeating terminal errors. Declared synthetic transport
responses exercise delayed snapshots and STALE_LEASE; the service restart/lease,
media failure, scheduler and native playback cases use actual local components.

Committed results:

- [Full Firefox evidence](evidence/phase-3-firefox.json).
- [Production development-path smoke](evidence/phase-3-dev-firefox.json).

Measurements are command submission → server-observed player epoch acknowledgement,
including Selenium polling overhead; they do not measure audible/HDMI latency.
Resume error compares the actual seeked position with the saved paused checkpoint.
The evidence records browser build, check results and individual measurements.
Final full-run acknowledgement measurements were 96–4,715 ms; resume error was
0.000 s at 1,234.532 s. A disconnected tab became silent 12.335 s after outage
(within its remaining 15-second lease); explicit takeover started after 15.237 s.
Both runs verified their Firefox output on a dedicated null sink.
`./scripts/check` passed 15 Python tests, 5 policy tests and 34 TypeScript tests,
both typechecks and the browser build.

## Boundaries and integration

No shared contract/server/core/migration/dependency changes were needed; there are
no contract proposals. Scheduling, bounded retry/refund rules and worker retention
remain the integration owner's implementation. Browser volume is separate from
OS/HDMI volume. Live PH ID, real-source availability on the eventual server,
production hosting, final display composition and venue rehearsal remain later gates.

Headless Firefox establishes decoding, media state, seeks and audio-analysis data;
it does not establish audible sound or HDMI routing. Actual laptop sleep/wake,
wall output and monitor performance are pending. A suspended browser can run its
JavaScript silence guard only when execution resumes; this is not an OS audio
watchdog. Pagehide delivery is best effort, and a crash can replay the last
five-second checkpoint interval. No seamless/sample-accurate resume is promised.

## Economical subagent outcome

One bounded harness task used `codex_cli_other`, `gpt-6-luna`, medium reasoning and
default service tier, in an isolated worktree. Task ID:
`node:delegated-task:command%3Amcp%3A9fe9c7e1-1a35-4d73-ac0d-fb9e0f769858%3Adelegate-task%3Aphase3-firefox-harness-1`.
Its unrun scaffold was adopted in `2a19dfd`. Lead review found integration problems
including a fixture-server path pointing under `src/server/` instead of `scripts/`
and unsupported Selenium wait arguments. The lead substantially revised the
harness in `ca4271a`, retained production lease/heartbeat constants, added the real
development-path smoke, and ran the final scenarios. It supplied useful structure,
but its original output was not runnable evidence and needed substantial review;
this task did not establish an efficiency win. No additional agent rounds were used.
