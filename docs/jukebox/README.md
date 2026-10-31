# Jukebox project plan

Status: discovery and requirements discussion. Updated 2026-10-30.

This is the starting point for planning and later phase chats. No jukebox runtime
has been implemented. The user has returned and clarified audio-only playback,
song/mix interruption, a separate repository, and exact dashboard visual reuse.
The canonical implementation repository is
<https://github.com/purduehackers/jukebox>. The separate Hack Night dashboard
remains the visual and integration reference.

## Intended experience

One laptop drives the video wall. The existing Hack Night dashboard occupies the
left area; `jukebox.purduehackers.com/display` occupies the right area and plays
music through the laptop's HDMI audio output. The exact screen/window arrangement
still needs confirmation: two tabs in one window cannot both be visible at once.

An organizer uses `/admin` from another browser/device to control playback and
both queues. An attendee scans a QR code leading to `/queue`, submits a music
link, and sees the request's status. The master queue contains organizer-selected
music, including long mixes. Periodically the player pauses the master track,
plays user-requested music, and resumes the master track at its saved position.
When a request becomes due, a normal song finishes; a mix longer than six minutes
may be interrupted. Audio must remain audio-only throughout: no embedded video,
video download, or video stream fallback.
The next request turn follows another 15 minutes of master playback after the
previous requested music. The diagram suggests user songs shorter than six minutes
and possibly three submissions per person per night. Slot size, pause/buffering,
empty-slot, and quota rules are still open.

The dashboard/now-playing display needs song information, a QR code, and possibly
a countdown to the next request slot. Visualizer placement, Lunar Lander sharing,
and whether “dash” means the existing dashboard or the new jukebox display remain
open. The canonical project name is Jukebox; old music URLs in the drawing are
superseded by the intended jukebox hostname.

## Documents

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
- [Phase 4C: display and dashboard](phases/04c-display.md).
- [Phase 5: integration and deployment](phases/05-integration-and-deployment.md).

## Proposed architecture

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
   track, validates duration/quota, and shows queue status. It produces no music.
5. **Read-only presentation:** renders shared now-playing state, next-request
   timing, and QR code on the jukebox display and/or existing dashboard. It does
   not infer that a song is audible just because a play command was accepted.
6. **Audio worker/cache:** resolves an allowed source to audio-only media, prepares
   a seekable asset, and manages temporary storage. The browser plays the audio
   asset; it does not execute `yt-dlp`. Current recommendation: a hosted production
   worker, with the same process running locally during development. This is a
   proposal pending source/hosting tests, not an accepted hosting decision. Keep
   the active/suspended master asset pinned.

A source link and a playable recording are different records. Store the submitted
URL and requested version separately from the selected playable provider item.
YouTube, Spotify, and Apple Music support should be explicit capabilities, not a
promise to play any arbitrary URL.

## Order of work

| Stage | Outcome | Depends on |
| --- | --- | --- |
| 0, here | Clarify timer, source feasibility, identity, and hardware | Remaining user and engineer answers |
| 1 | Prove real playback, interrupt/resume, and HDMI operation locally | Playback and layout decisions |
| 2 | Establish durable state, API/events, scheduling semantics, and fixtures | Stage 1 plus queue/identity decisions |
| 3 | Connect the designated playback browser and prove remote control/recovery | Stage 2 contracts |
| 4A | Admin queue and player controls | Stage 2; use mock player until 3 is ready |
| 4B | Attendee link submission and quota/moderation feedback | Stage 2 plus identity/source decisions |
| 4C | Wall display, QR, dashboard integration, optional visual work | Stage 2 contracts and confirmed wall layout |
| 5 | Integrate, rehearse on the wall, preview deploy, DNS, production operation | Stages 3 and 4 plus hosting/access |

Stage 3 and the three stage-4 components can proceed in parallel **after** the
shared contracts are stable. Initially use one integration owner for shared
contracts and separate file ownership for each UI. Admin and attendee clients
should use fake player/source adapters until the real integrations are ready.
Visualizer research can run alongside these, but should not delay basic music.

Do not launch all phase chats yet. The unanswered questions materially affect
the player, queue service, and worker location. Once answered, update the docs,
commit the shared baseline, and launch the first ready phase. Independent phase
implementation should use separate worktrees based on the agreed parent branch.

## Local-first milestones

- First: real provider playback and master resume in one browser, no polished UI.
- Next: two browser profiles or devices share one local queue service. An admin
  action controls the display while the admin and attendee pages remain silent.
- Next: simulate a whole night using a test clock, including empty queues,
  failures, refresh, reconnect, quota reset, and competing display tabs.
- Next: actual laptop, wall geometry, HDMI route, and announcement coexistence.
- Last: isolated preview environment, then production domain and night-of runbook.

`localhost` on a phone points to the phone, not the laptop. Remote-device tests
will need an approved reachable development address; secure-origin and identity
callback requirements must be verified for the chosen browser and auth provider.
Existing dashboard fixtures are useful, but are not yet a complete offline
jukebox environment.
