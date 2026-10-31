# Jukebox: consolidated plan for approval

Status: ready for user review, not yet approved. Prepared 2026-10-30.

This is the single summarized approval document. It combines the user's confirmed
requirements with explicitly proposed defaults for remaining edge cases. Approval
adopts those defaults and permits starting phase 1. Implementation and new phase
chats wait for that approval; production deployment and paid infrastructure remain
later steps. The detailed briefs and research support this plan.

## 1. What we are building — confirmed

A separate Purdue Hackers Jukebox in `purduehackers/jukebox`, intended for
`jukebox.purduehackers.com`:

- `/display`: Firefox on the dedicated second monitor. Plays audio through HDMI
  and presents Jukebox's display. One paired browser owns venue playback.
- `/queue`: QR-linked attendee page. PH ID sign-in, three songs per person per
  admin-managed night session, automatic admission after validation, request status.
- `/admin`: remotely control volume, play/pause, seek, skip/replay; add music and
  supported playlists; remove/reorder either queue; start/end night sessions.

Use the dashboard's actual fonts, colors, borders, and dithering. The existing
dashboard/chat on the other monitor is only a visual reference; do not change it
or build cross-dashboard integrations. The user's
[display sketch](references/display-sketch.png) sets the composition: a large
audio-reactive dithered visualizer on the left, a now-playing/artwork strip below,
and queue entries with a request QR area on the right. Real audio analysis driving
the visualization is a requirement; a decorative looping shader alone is not.
Detailed signal analysis, shader behavior, final layout, and possible Lunar sharing
belong in the later display component discussion.

## 2. Music behavior — confirmed

- Two queues: organizer-controlled master music and attendee requests.
- After 15 minutes of master playback, take exactly one user song.
- Master tracks of six minutes or less finish before that request starts.
- Master tracks over six minutes count as mixes: interrupt, save the position,
  play the user song, then resume the mix.
- After the request, begin another 15-minute master playback period.
- An empty request turn waits another 15-minute interval; it does not stay open
  to play a late arrival immediately.
- The 15-minute master period uses elapsed time: pausing/buffering does not freeze
  it, and seeking does not jump it. It restarts after the user request or an empty
  turn. With uninterrupted master music, empty at 9:15 plus submission at 9:17
  means the next opportunity is 9:30, respecting a normal song's end.
- Quota counts accepted submissions, with refunds for technical playback failures.
- Night quotas reset through admin-managed sessions, not at midnight.
- No video media downloaded, streamed, or embedded anywhere in the music path.

## 3. Recommended defaults — included in this approval request

These fill gaps; they are not represented as already-confirmed user answers.

- **Paused at a due turn:** keep the elapsed timer running, mark the request due,
  and wait for organizer resume rather than overriding a deliberate pause. The
  song/mix boundary rule still applies when playback resumes.
- **Request length:** retain the sketch's strict under-six-minute limit for user
  requests. A master track exactly six minutes long remains a normal song.
- **Quota details:** reserve allowance atomically after validation. Invalid
  submissions use none; preparation failures receive the same refund as technical
  playback failures. Admin removal or deliberate skip does not automatically refund.
- **Ordering:** FIFO unless an admin reorders; reject the same playable recording
  already waiting in the user queue. No voting or per-user round-robin in v1.
- **Failure/skip:** retry transient failures a bounded number of times. A failed
  user request is refunded and returns to master; an admin-skipped user song also
  returns to master. Both finish the request turn and begin a fresh master period.
- **Master exhaustion:** loop the organizer's master list. If no usable master
  items exist, show an admin alert and remain paused rather than draining requests
  outside their schedule. A skipped master item advances without resetting the
  accumulated master timer; unresolved source failures must not loop forever.
- **Night end:** pause playback, close submissions, and archive/clear pending
  requests for the next session. Keep the organizer's master library/list.
- **Recovery:** preserve shared queues and checkpoints across supported restarts;
  reconnect without consuming a request twice. On full display reload, restore
  state and show Activate/Resume if Firefox requires local interaction. A second
  display cannot silently take over or produce duplicate venue audio.

## 4. Recommended technical approach

Use a React/TypeScript web app aligned with the dashboard's component conventions,
a durable shared queue service, and an audio worker with a temporary seekable
cache. Develop the complete stack locally first, with mock auth/metadata and a
test clock for routine checks. Use the same worker process in hosted production
so the venue laptop can remain browser-only. Exact runtime/database/hosting follow
the feasibility result and infrastructure engineer input.

The user reports that an existing server is quite capable. Evaluate that server
first for the hosted media worker/cache and any relevant processing rather than
assuming new hosting or a serverless-only design. Specs, available runtime/storage,
network access, and ownership are for the infrastructure discussion, not assumed.
For PH ID, inspect and integrate the current `purduehackers/id` repo/code in the
auth phase; no new identity system is being built here.

The worker resolves metadata and prepares strictly audio-only assets using a
maintained extractor such as yt-dlp and FFmpeg when needed. Preserve a compatible
source codec rather than automatically converting everything to MP3. Serve media
through a seekable endpoint; pin a suspended mix until it resumes and delete unused
temporary files with bounded storage/cleanup. Backend acceptance and actual
browser playback are distinct states shown truthfully in the admin UI.

Launch target: YouTube track/mix links; Spotify and Apple Music track links as
metadata requests matched to playable audio, with a preview of the recording.
Admin imports target YouTube and Spotify playlists. Unsupported/ambiguous sources
must get clear feedback; never silently substitute an unrelated track or fetch
video as a fallback. Other providers are later adapters, not a universal URL promise.

These are feasibility targets, not claims of working source access. Phase 1 must
prove audio-only acquisition, long-mix seeking, Firefox compatibility, matching
requirements, and intended-host network access. If a source cannot meet those
requirements reliably, report the limitation and revise the plan before building
dependent features. Source/service constraints are recorded in AUDIO-RESEARCH.md.

## 5. Build order and separate chats

1. **Playback proof:** local audio worker/cache and minimal Firefox player.
   Demonstrate an hour-long mix → one request → resume, no video, seeking,
   preparation/cleanup, and failure handling. Verify a usable analysis path from
   the playing audio without building the final visualizer. Record observed limits.
2. **Shared foundation:** agree typed API/events; implement durable queues,
   scheduler, PH ID integration, organizer authorization, session quotas, paired
   playback authority, and local fixtures. Test timing and concurrent clients.
3. **Parallel component chats, after the shared contract is stable:**
   player/recovery; admin controls; attendee queue; dedicated display/design.
   Give each an isolated worktree and shared baseline, with one integration owner.
   The display chat uses the dashboard heavily as reference and resolves its
   final layout, real audio analysis/dithered visualization, and Lunar choices
   before implementing them, using the supplied sketch as the starting composition.
4. **Integration and rehearsal:** combine components, simulate a full night across
   midnight, test multiple browser/device roles, then validate real Firefox/HDMI
   and the second monitor. Produce a short organizer runbook and fallback procedure.
5. **Preview and production:** resolve engineer questions, deploy isolated preview
   state, test the real source/network and identity callbacks, configure the hosting
   project's actual DNS target through the org DNS repo, then verify production.

No dependent phase starts from unfinished contracts or uncommitted work. Prompts
already exist in HANDOFFS.md and will be aligned with this document on approval.
Later visual choices and infrastructure credentials are handled in their phases;
they do not require another round of general product discovery before phase 1.

## 6. Current deliverables

The new repository and `feat/jukebox-planning` branch exist. Research, exact visual
tokens/assets inventory, detailed component briefs, phase prompts, and engineer
questions are published there. There is no Jukebox application or deployment yet.

Requested approval: this scope, sequence, recommended architecture, and the defaults
in section 3. Approval starts phase 1, not all implementation chats at once.
