# Jukebox project plan

Status: local phases 1–4 are integrated, including PH ID, dark admin/queue UI,
organizer-authenticated automatic Firefox playback and the approved stationary soundbar. Production and
venue gates remain open. Updated 2026-11-06.

Read [Current implementation and deployment readiness](CURRENT-STATUS.md) first
for actual behavior, startup, baseline and release blockers. The original plan
was approved on 2026-10-30; later decisions supersede its pairing, activation,
fixed-mode and deferred-display descriptions. No new plan approval is needed.
The older architecture/order sections below preserve the planning context, not
instructions to restart completed phases. The separate Hack Night dashboard
remains a visual reference only and is outside this implementation scope.

## Original intended experience (see current status for overrides)

One laptop drives the video wall. The existing Hack Night dashboard occupies the
left area; `jukebox.purduehackers.com/display` occupies the right area and plays
music through the laptop's HDMI audio output in Firefox. These are two independent
monitors. Jukebox's detailed display design is deferred to its dedicated discussion;
the other dashboard's chat, layout, and runtime do not need modification.

An organizer uses `/admin` from another browser/device to control playback and
both queues. An attendee scans a QR code leading to `/queue`, submits a music
link, and sees the request's status. The master queue contains organizer-selected
music, including long mixes. Periodically the player pauses the master track,
plays user-requested music, and resumes the master track at its saved position.
When a request becomes due, a normal song finishes; a mix longer than six minutes
may be interrupted. Audio must remain audio-only throughout: no embedded video,
video download, or video stream fallback.
Each turn plays exactly one user song. The next follows another 15 minutes of
master playback; an empty turn waits a new interval. Attendees must use PH ID and
get three songs per person per admin-managed night session. Requests enter
automatically and admins can remove them. The master timer uses elapsed time,
including pause/buffering, and empty turns reset the interval. Quota counts accepted
submissions and refunds technical failures. Further defaults are in the approval plan.

The user's [display sketch](references/display-sketch.png) places a large real
audio-reactive dithered visualizer on the left, now-playing/artwork below it, and
a queue sidebar with request QR on the right. Detailed listener/shader/layout work
and Lunar Lander sharing remain for the display discussion. The existing dashboard is not an integration
target. The canonical project name is Jukebox; old music URLs in the drawing are
superseded by the intended jukebox hostname.

## Documents

- [Link compatibility](LINK-COMPATIBILITY.md): current YouTube URL normalization, real-worker startup, live Spotify/Apple metadata matching, research and measured limitations.

- [Phase-3 Firefox player](PHASE-3-FINDINGS.md): pairing, activation, lease fencing,
  recovery evidence, measured acknowledgement/resume results, and venue gates.
- [Queue playback controls proposal](proposals/queue-playback-controls.md): modes, Play now, request interval.
- [Phase-2 contract and service](PHASE-2-CONTRACT.md): behavior table, typed
  commands/snapshots, authority/lease semantics, PH ID status, evidence, limitations.
- [Phase-4B attendee queue](PHASE-4B-QUEUE.md): `/queue` page, preview-before-submit,
  Spotify/Apple matcher design, QR origin rule, evidence, limitations; contract
  [proposals](proposals/phase-4b.md) for the integration owner.
- [Phase-1 measured findings](PHASE-1-FINDINGS.md): implemented local runtime,
  Firefox/source evidence, boundaries, interface proposals, and pending gates.

- [Discovery and deployment findings](DISCOVERY.md): evidence from this repo,
  related org repositories, public DNS, and provider documentation.
- [Decisions and question backlog](DECISIONS.md): confirmed intent, deferred
  questions, and edge cases.
- [Engineer questions](ENGINEER-QUESTIONS.md): a ready-to-send list; no message
  has been sent on the user's behalf.
- [Audio pipeline research](AUDIO-RESEARCH.md): bot architectures and streaming
  versus temporary audio caching for mixes.
- [Dashboard design reference](DESIGN-REFERENCE.md): exact tokens, fonts, borders,
  and shader settings to preserve in the new app.
- [Phase chat prompts](HANDOFFS.md): ordered prompts and workspace guidance.
- [Phase 1: playback feasibility](phases/01-playback.md).
- [Phase 2: shared state and queue rules](phases/02-state-and-scheduling.md).
- [Phase 3: player and recovery](phases/03-player.md).
- [Phase 4A: admin controls](phases/04a-admin.md).
- [Phase 4B: attendee requests](phases/04b-requests.md).
- [Phase 4C: dedicated jukebox display](phases/04c-display.md).
- [Phase 5: integration and deployment](phases/05-integration-and-deployment.md).

## Original architecture and phase plan (historical)

These are design proposals to discuss. The separate repository is confirmed;
hosting and the media worker's location remain open.

1. **Shared queue service:** owns event/session identity, master and user queues,
   validation results, scheduling state, saved master position, authorization,
   and the currently designated playback device. Persists changes atomically.
2. **Player at `/display`:** obtains playback authority, starts audio after a
   local activation gesture when required, executes commands, and reports actual
   playing/paused/buffering/error status and position. Sends HDMI audio.
3. **Admin at `/admin`:** submits authorized commands, manages queues, and shows
   command acknowledgement plus player connection state.
4. **Attendee at `/queue`:** accepts supported music links, previews the resolved
   track, requires PH ID, validates duration/three-song session quota, and shows
   queue status. It produces no music. No manual song approval gate is required.
5. **Read-only presentation:** renders shared now-playing state, next-request
   timing, and QR code within Jukebox's dedicated display. It does
   not infer that a song is audible just because a play command was accepted.
6. **Audio worker/cache:** resolves an allowed source to audio-only media, prepares
   a seekable asset, and manages temporary storage. The browser plays the audio
   asset; it does not execute `yt-dlp`. Current recommendation: a hosted production
   worker, with the same process running locally during development. This is a
   approved architectural direction pending source/hosting tests and actual server
   selection; it does not authorize new paid infrastructure. Keep
   the active/suspended master asset pinned.

Use the existing `purduehackers/id` code when implementing PH ID. The user reports
an existing capable server: evaluate it for hosted worker/cache and relevant
processing before proposing new infrastructure. Actual specs/access/runtime and
browser-versus-server visualizer responsibilities are later phase decisions.

A source link and a playable recording are different records. Store the submitted
URL and requested version separately from the selected playable provider item.
YouTube, Spotify, and Apple Music support should be explicit capabilities, not a
promise to play any arbitrary URL.

## Original order of work (phases 1–4 now integrated)

| Stage | Outcome | Depends on |
| --- | --- | --- |
| 0, here | Clarify remaining timer/quota/source details and runtime | Remaining user and engineer answers |
| 1 | Prove real playback, interrupt/resume, and HDMI operation locally | Playback and layout decisions |
| 2 | Establish durable state, API/events, scheduling semantics, and fixtures | Stage 1 plus queue/identity decisions |
| 3 | Connect the designated playback browser and prove remote control/recovery | Stage 2 contracts |
| 4A | Admin queue and player controls | Stage 2; use mock player until 3 is ready |
| 4B | PH ID submissions, three-song session quota, automatic queue feedback | Stage 2 plus source/accounting decisions |
| 4C | Dedicated display, real audio-reactive dithering, queue/QR, exact dashboard visual identity | Stage 2 contracts, audio-analysis proof, and display discussion |
| 5 | Integrate, rehearse on the wall, preview deploy, DNS, production operation | Stages 3 and 4 plus hosting/access |

Stage 3 and the three stage-4 components can proceed in parallel **after** the
shared contracts are stable. Initially use one integration owner for shared
contracts and separate file ownership for each UI. Admin and attendee clients
should use fake player/source adapters until the real integrations are ready.
Visualizer design can proceed alongside these once the playing-audio analysis
path is established; it is a required display component rather than idle decoration.

Do not launch all phase chats at once. The plan is approved and phase 1 is ready
to start; its feasibility findings inform the shared foundation. Commit each
shared baseline before launching dependent work. Independent phase
implementation should use separate worktrees based on the agreed parent branch.

## Local-first milestones

- First: real provider playback and master resume in Firefox, no polished UI.
- Next: two browser profiles or devices share one local queue service. An admin
  action controls the display while the admin and attendee pages remain silent.
- Next: simulate a whole night using a test clock, including empty queues,
  failures, refresh, reconnect, quota reset, and competing display tabs.
- Next: actual laptop, dedicated monitor dimensions, HDMI route, and Firefox recovery.
- Last: isolated preview environment, then production domain and night-of runbook.

`localhost` on a phone points to the phone, not the laptop. Remote-device tests
will need an approved reachable development address; secure-origin and identity
callback requirements must be verified for the chosen browser and auth provider.
Existing dashboard fixtures are useful, but are not yet a complete offline
jukebox environment.
