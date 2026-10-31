# Decisions and question backlog

Review checkpoint: the user requested a finalized summarized plan for approval.
Use [APPROVAL-PLAN.md](APPROVAL-PLAN.md) for that review. Existing questions below
are the discovery record; proposed defaults in the approval plan are not answers
the user has already given. Do not send further general question batches while
this plan is pending approval.

Updated 2026-10-30 after the user's return and first answers. Repository ownership,
audio-only presentation, and song-versus-mix interruption are now substantially
clearer. The user subsequently chose another 15 minutes of master playback after
requested music rather than fixed clock slots. Exactly one request plays per turn;
PH ID and three songs per person per night are confirmed. The wall has two
independent monitors, and dashboard changes are outside scope. The user also chose
automatic requests, admin-managed night sessions, waiting a new interval after an
empty turn, and Firefox. Latest answers confirm the empty-turn reset example,
elapsed time during pause/buffering, accepted-submission quota, and technical
failure refunds. Remaining defaults are consolidated in the pending approval plan.

## Confirmed intent

- Name: Jukebox; intended hostname `jukebox.purduehackers.com`.
- Laptop connected through HDMI; `/display` is intended to produce the music.
- Two independent monitors: existing dashboard on the left, jukebox display on
  the right. The existing dashboard is only a visual reference; no changes to
  its chat/layout or cross-dashboard integration belong in this project scope.
- `/admin` controls music from another browser/device.
- QR code takes attendees to `/queue`.
- Separate master and user queues. Master can contain long mixes.
- Master should pause for requested music and continue afterward at its position.
- A normal master song should finish before a due request. Tracks longer than six
  minutes count as mixes and may be interrupted. Working interpretation: exactly
  six minutes is still a song; the strict attendee-submission cutoff remains open.
- Audio only: no video should be downloaded, streamed, or embedded, including a
  hidden video fallback. Research `youtube-dl`/`yt-dlp`-style audio sourcing.
- Build in its own Purdue Hackers repo, `purduehackers/jukebox`, with all jukebox
  routes under the intended jukebox hostname. No jukebox domain/deploy exists yet.
- Match the dashboard's exact fonts, colors, borders, and dithering. The dashboard
  is a visual reference rather than an integration target or implementation home.
- After requested music, allow another 15 minutes of master playback before the
  next request turn. Fixed wall-clock slots are ruled out. Exactly one user song
  plays per turn, then the master queue resumes.
- If a due request turn is empty, wait for a new 15-minute interval rather than
  playing a later submission immediately. Confirmed: reset at the empty turn;
  empty at 9:15 and a request at 9:17 waits until 9:30 with uninterrupted master music.
- The master period counts elapsed time even while paused/buffering. Seeking
  does not change the timer. It is anchored to each fresh master period, not a
  fixed clock schedule spanning user-song time.
- The designated display browser is Firefox. OS and resolution can be confirmed
  during playback/display feasibility work rather than reopening monitor layout.
- Admin: volume, play/pause, skip/replay, seek; add items/playlists; remove and
  reorder items in both queues.
- Submission intent includes YouTube, Spotify, Apple Music, and potentially other
  links. Which launch first, and whether all resolve to one provider, are open.
- Attendees must sign in with Purdue Hackers ID. The quota is three songs per
  person per admin-managed night session. Admins start/end sessions and allowance
  resets for the next session, not at midnight. Count accepted submissions and
  refund technical playback failures. Further removal/skip defaults and the
  diagram's strict under-six-minute request limit
  still needs its exact boundary clarified.
- Valid requests join automatically, without per-song admin approval. Admins may
  remove requests. Validation failures and source preparation are not approval gates.
- Work locally first, split the project into discussion/implementation phases,
  then deploy after understanding existing infrastructure.

## Current questions

Ask a small batch and use the answers to narrow subsequent questions.

1. **Scheduling:** Exactly one request per turn, with the song/mix rule and a new
   15-minute elapsed master period afterward. Empty turns reset the interval;
   pausing/buffering does not stop it. Handling a deliberately paused due turn is
   proposed in the approval plan.
   A seek must not silently count skipped media as listening time.
2. **Worker location:** The user asked for a researched recommendation rather
   than selecting either option. Proposed: hosted media worker in production,
   the same worker locally for development, subject to phase-1 hosting-network
   source tests and engineer runtime/storage input. Not yet an accepted decision.
3. **Playback source:** Audio-only sourcing is required; a visible/hidden video
   player is ruled out. Which launch link types need metadata matching, and how
   should ambiguous Spotify/Apple matches be resolved?
4. **Quota accounting:** PH ID, three songs, and admin-managed night sessions are
   settled, as are accepted-submission counting and technical failure refunds.
   Remaining defaults and organizer authorization follow the approval plan.
5. **Display details, deferred:** Two independent monitors are confirmed. Use the
   dashboard heavily as a visual reference when the dedicated display discussion
   begins. Firefox is confirmed; OS/resolution and Lunar placement remain deferred.
6. **Failure/removal behavior:** Requests enter automatically and admins can
   remove them. Define skip/failure/quota behavior. Existing dashboard coordination
   is outside scope; do not add it by default.

## Next questions, after the first answers

### Scheduling and queue edge cases

- Confirmed empty-turn example: with uninterrupted master playback, an empty
  turn at 9:15 restarts the interval; a request at 9:17 waits until 9:30. These times
  illustrate elapsed master playback, not a new fixed-clock scheduling policy.
- If the master queue is empty, play user requests immediately, stay silent, or
  use a fallback? At master exhaustion, repeat the mix, loop the list, or stop?
- Confirmed: buffering and pauses do not freeze the elapsed master timer; seeks
  do not jump it. Remaining disconnection/skip/recovery defaults are proposed in
  the approval plan rather than inferred as past user answers.
- If a request takes longer than a slot or loading stalls, can due slots stack?
  Define a bounded catch-up policy; never unleash a backlog of overdue interrupts.
- If an admin skips a user song, does that finish the slot or take the next user
  song? If the admin skips master while it is suspended, what resumes afterward?
- Technical playback failures refund allowance. The approval plan proposes bounded
  retries and return to master after failure; that behavior is pending approval.
- Is the resume promise an approximate song position or sample-accurate seamless
  audio? A browser/provider seek should be tested before promising precision.
- FIFO requests, round-robin by person, votes, or another fairness rule? Can the
  same person occupy consecutive request slots?
- Are duplicate versions allowed in the pending queue, across queues, or after
  a song played? Can a requester withdraw or replace an item?
- Does an attendee see a queue position, an estimated time, or a guaranteed slot?
  Estimates must reflect admin reorder, moderation, failures, and slot semantics.

### Session, identity, and moderation

- Admins start/end the night session; midnight does not reset quota. Decide how
  pending requests and master playback behave on session end/new-session start.
- Count submissions, accepted songs, pending songs, or successfully played songs
  toward the quota? What happens on rejection, removal, cancellation, or failure?
- How should an attendee without a PH account reach registration? Do not add
  guest submissions; PH ID is required. Who may be an admin, and how are organizer
  rights granted/revoked?
- Are explicit tracks allowed? Any artwork/metadata rules, artist blocks, or an
  emergency pause/clear action? Do requests need a visible submitter name?
- Enforce the three-song limit against stable PH ID identity, not cookies or a
  shared venue IP. Verify the current provider's stable subject claim.
- Are user playlists forbidden while admin playlists are supported? Are live
  streams, unknown durations, podcasts, and non-music video links allowed?
- Does the attendee limit remain strictly below 360 seconds, or is exactly 360
  seconds allowed as an individual song? Whose metadata
  decides duration after matching, especially when versions differ?

### Source and playback operation

- If metadata matching finds a remix, live version, or uncertain result, should
  the attendee choose a result or should an admin resolve it?
- Public or private Spotify/YouTube playlists? Snapshot imports once or follow
  updates? How should repeats, unavailable tracks, and partial import failures work?
- Are subscriptions/accounts available on the display laptop? Is a single local
  activation click at startup acceptable? What tolerance for ads/loading gaps?
- After refresh or laptop restart, resume the same track/position, recover paused,
  or ask the organizer? When connectivity fails, finish current music or pause?
- What should happen if someone opens a second `/display`? A public visitor
  should not silently take over the venue's audio or obtain device authority.
- Does remote volume mean player volume only, or OS/HDMI volume too? A normal
  webpage cannot promise control over the laptop's system mixer.

### Presentation and scope

- Where should now-playing, next-slot countdown, pending requests, and QR appear
  within Jukebox's dedicated display? Defer its visual discussion; do not add
  content to the existing dashboard monitor.
- Is a genuine music-reactive visualizer required now, optional later, or is
  decorative motion sufficient? It affects source/capture requirements.
- Keep Lunar separate, embed its display, rotate modes, or overlay a small music
  status panel? Preserve its existing remote camera and play-window behavior.
- What is the first demo target/date, expected attendee count, organizer count,
  and acceptable request-to-control latency? Any ongoing hosting budget?

## Decisions table

| ID | Choice | Status | Consequence |
| --- | --- | --- | --- |
| D01 | Jukebox name and intended hostname | Confirmed | Use jukebox URLs in new docs |
| D02 | Display browser emits HDMI music | Intended; hardware test needed | Other clients remain silent |
| D03 | Master pause/resume around requests | Confirmed intent | Save provider item and position |
| D04 | Request cadence | One user song, then 15 elapsed minutes in master; pauses/buffering count; empty turns reset interval | Due-while-paused and recovery defaults await plan approval |
| D05 | Provider and cross-service matching | Audio-only confirmed; implementation under research | No video fallback; resolve links separately |
| D06 | Repo/service/hosting ownership | Separate org repo confirmed and created | `purduehackers/jukebox`; runtime/hosting still open |
| D07 | Identity and quota | PH ID; three accepted submissions/person/admin-managed night; technical failures refunded | Removal/skip and session-end defaults await plan approval |
| D08 | Moderation and failure behavior | Automatic requests; admin removal confirmed | Failures, skips, and quota effects remain open |
| D09 | Wall/Lunar/visualizer layout | Two independent monitors confirmed | Dedicated Jukebox design and optional Lunar placement are deferred |
| D10 | Existing dashboard integration | Outside scope | Dashboard is a visual reference; no changes or cross-dashboard coordination |
| D11 | Visual identity | Confirmed | Match exact dashboard tokens/assets and dithering |
| D12 | Audio worker placement | Hosted worker recommended; user has not selected | Run the same worker locally first; verify intended hosting network |
| D13 | Display browser | Firefox confirmed | Validate actual target codec, activation, seek, and recovery behavior |

## Answer provenance

The user said individual songs should not be interrupted, and tracks longer than
six minutes should be treated as mixes that may be interrupted. They explicitly
rejected any video streaming and requested research into audio extraction,
streaming versus temporary downloads, and deletion after use. They chose a
separate Purdue Hackers repo and explained that the dashboard was provided as the
exact UI reference. GitHub subsequently allowed creation of
<https://github.com/purduehackers/jukebox>, with ADMIN access for this account.

In the next answer, the user selected “Another 15 minutes of master music” and
asked the agent to recommend a worker location after research. This settles the
interval reset but does not approve a hosted provider, budget, or laptop helper.

The next answers selected exactly one user song per request turn, required PH ID,
and three songs per person per night. The user confirmed two independent monitors
and explicitly said not to change the existing dashboard/chat: its purpose here
is visual reference for the later Jukebox display discussion.

The latest answers selected automatic request admission with admin removal,
admin-managed night sessions, and waiting a new 15-minute interval after an empty
turn. The user then specified Firefox. They subsequently confirmed the empty-turn
example, selected elapsed-time counting during pause/buffering, and selected
accepted submissions with technical playback failure refunds. These supersede the
earlier proposed playback-only timer. They also requested a finalized plan to approve.

When a decision is made, record the user's answer, date, rationale, and affected
phase. Avoid silently resolving open questions through implementation defaults.
