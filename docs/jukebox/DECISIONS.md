# Decisions and question backlog

Updated 2026-10-30 after the user's return and first answers. Repository ownership,
audio-only presentation, and song-versus-mix interruption are now substantially
clearer. Interval reset and the remaining identity/hardware/moderation choices
are still open.

## Confirmed intent

- Name: Jukebox; intended hostname `jukebox.purduehackers.com`.
- Laptop connected through HDMI; `/display` is intended to produce the music.
- Existing dashboard on the left, jukebox display on the right; geometry unknown.
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
  is a reference/integration target rather than the jukebox implementation home.
- Rough request cadence: every 15 minutes; precise meaning is open.
- Admin: volume, play/pause, skip/replay, seek; add items/playlists; remove and
  reorder items in both queues.
- Submission intent includes YouTube, Spotify, Apple Music, and potentially other
  links. Which launch first, and whether all resolve to one provider, are open.
- Diagram proposes user songs shorter than six minutes. Three per person/night
  is explicitly tentative, including how to enforce it.
- Work locally first, split the project into discussion/implementation phases,
  then deploy after understanding existing infrastructure.

## Current questions

Ask a small batch and use the answers to narrow subsequent questions.

1. **Scheduling:** Respect the song/mix interruption rule above. Play one request
   or drain a block? Does the next 15 minutes start
   after the request ends, count only master playback time, or follow fixed
   wall-clock slots? Does manually pausing freeze the timer?
2. **Worker location:** Is a small audio helper on the venue laptop acceptable,
   or should extraction/caching live on a hosted media worker? OS/browser and
   venue network details affect this choice.
3. **Playback source:** Audio-only sourcing is required; a visible/hidden video
   player is ruled out. Which launch link types need metadata matching, and how
   should ambiguous Spotify/Apple matches be resolved?
4. **Identity/quota:** Require Purdue Hackers ID, allow anonymous QR submissions,
   or support both? Is three songs per person per night a firm requirement?
5. **Hardware/layout:** Laptop OS/browser and wall resolution? Two independent
   screens/windows, or one wide canvas? How should Lunar Lander share the space?
6. **Moderation/announcements:** Automatic validated requests or admin approval?
   Should dashboard announcements/countdown pause or lower the music volume?

## Next questions, after the first answers

### Scheduling and queue edge cases

- If a slot arrives with no requests, is it skipped, kept open until a request
  arrives, or does the next slot start a full interval later?
- If the master queue is empty, play user requests immediately, stay silent, or
  use a fallback? At master exhaustion, repeat the mix, loop the list, or stop?
- Is the timer a wall-clock interval or accumulated audible master-playing time?
  How do buffering, disconnection, admin pause, seek, replay, and skip affect it?
- If a request takes longer than a slot or loading stalls, can due slots stack?
  Define a bounded catch-up policy; never unleash a backlog of overdue interrupts.
- If an admin skips a user song, does that finish the slot or take the next user
  song? If the admin skips master while it is suspended, what resumes afterward?
- On a failed user track, retry, try another request, or resume the master?
  Does the failure refund the attendee's allowance?
- Is the resume promise an approximate song position or sample-accurate seamless
  audio? A browser/provider seek should be tested before promising precision.
- FIFO requests, round-robin by person, votes, or another fairness rule? Can the
  same person occupy consecutive request slots?
- Are duplicate versions allowed in the pending queue, across queues, or after
  a song played? Can a requester withdraw or replace an item?
- Does an attendee see a queue position, an estimated time, or a guaranteed slot?
  Estimates must reflect admin reorder, moderation, failures, and slot semantics.

### Session, identity, and moderation

- What is a “night”: an admin-started event, a fixed date, or another period?
  Midnight occurs during Hack Night, so a midnight quota reset may be wrong.
- Count submissions, accepted songs, pending songs, or successfully played songs
  toward the quota? What happens on rejection, removal, cancellation, or failure?
- How should attendees without a PH account participate? Who may be an admin,
  and how are organizer rights granted/revoked?
- Are explicit tracks allowed? Any artwork/metadata rules, artist blocks, or an
  emergency pause/clear action? Do requests need a visible submitter name?
- Do anonymous users only get a soft convenience quota? Cookies can be cleared;
  IP quotas can penalize the whole venue behind shared Wi-Fi/NAT.
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

- Where should now-playing, next-slot countdown, pending requests, and QR appear?
  Is a QR needed on both halves? What does “dash” refer to in later instructions?
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
| D04 | Exact 15-minute semantics | Partly confirmed: finish songs; interrupt mixes over six minutes | Reset, block size, and empty-slot behavior remain open |
| D05 | Provider and cross-service matching | Audio-only confirmed; implementation under research | No video fallback; resolve links separately |
| D06 | Repo/service/hosting ownership | Separate org repo confirmed and created | `purduehackers/jukebox`; runtime/hosting still open |
| D07 | Identity, night boundaries, quota accounting | Open | Blocks enforceable request rules |
| D08 | Moderation and failure behavior | Open | Blocks request lifecycle |
| D09 | Wall/Lunar/visualizer layout | Open | Blocks final display design |
| D10 | Announcement audio priority | Open | Blocks cross-origin coordination design |
| D11 | Visual identity | Confirmed | Match exact dashboard tokens/assets and dithering |

## Answer provenance

The user said individual songs should not be interrupted, and tracks longer than
six minutes should be treated as mixes that may be interrupted. They explicitly
rejected any video streaming and requested research into audio extraction,
streaming versus temporary downloads, and deletion after use. They chose a
separate Purdue Hackers repo and explained that the dashboard was provided as the
exact UI reference. GitHub subsequently allowed creation of
<https://github.com/purduehackers/jukebox>, with ADMIN access for this account.

When a decision is made, record the user's answer, date, rationale, and affected
phase. Avoid silently resolving open questions through implementation defaults.
