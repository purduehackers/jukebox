# Decisions and question backlog

## Organizer-only display and stream authorization (2026-11-06)

The user first accepted organizer login for the display, then explicitly clarified
that **the entire display must require organizer login**, with no public viewing
mode. This supersedes the public/universal access portion of the 2026-11-05
decision below. Multiple organizer displays, automatic playback after login,
no pairing and no exclusive lease remain. `/visual` also requires organizer login
because it uses the same audio/reporting player.

`display.connect` now requires admin authorization. Every automatic-player HTTP
request requires both its report token and a currently valid organizer session;
a copied token or an old anonymously issued token alone is insufficient. The UI
mounts no live display/player before organizer access is confirmed. Logout/expiry
closes privileged streams; the normal player stops on authorization failure.
Stream reauthorization uses local SQLite, without extra PH ID network requests.
No trusted-network configuration, public viewer mode or pairing flow was added.

The server remains queue/scheduler authority. Display reports are actual-playback
feedback used for terminal transitions, technical failures and resume positions;
the admin browser need not stay open. The user authorized efficient fixes and a
portability review. Production launcher, env/ingress/systemd examples and a
concrete operator guide are included. Storage is created in explicitly configured
server directories; DNS, secrets, persistent disk and actual host/venue tests
remain operator work. No production infrastructure change is implied.


Verification: 187 TypeScript tests, 21 Python tests, five policy tests, typechecks
and frontend build pass. The isolated production launcher creates service/worker
state at configured absolute directories and shuts both processes down. Firefox
159 passed all 18 checks, including no display/audio before organizer login,
logout stopping audio and fresh sign-in restoring it. Five night starts measured
300–351 ms and mix resume error was 0.000 seconds. Evidence is in
`evidence/organizer-display-firefox.json`. No live role grant, hosted source access,
production ingress or HDMI output is claimed.

## Minimal display request copy (2026-11-05)

Keep the request QR, “Song requests” heading, URL and original sizing. The user
removed only the “PH ID · 3 per night” line.

## Minimal attendee request status (2026-11-05)

The user removed the “Getting ready” badges from both **Your requests** and
**In the queue**. Keep preparation internal; do not restore those badges.

## Universal automatic display (2026-11-05)

The user requested a full connection/playback audit and explicitly replaced the
exclusive designated-player flow with one universal display. Competing tabs may
both produce sound; preventing that is unnecessary. Keep the display connected
across night sessions, with no linking, pairing, app sound-enable control, or
ownership wait. No night: **Night not started**, silent. Confirmed follow-up:
**Start night** immediately starts the master; **End night** immediately stops
sound and returns to that idle state. Reloads/brief interruptions resume the
current song near its saved position.

Firefox's native autoplay policy still applies. Attempt playback automatically;
use the browser's saved site permission rather than treating sound activation as
an app setup step. The server remains authoritative for scheduling/queues; the
open display browser still produces the HDMI audio. A server cannot make sound
through a closed tab. Preserve actual playback reports, stale-command fences,
media retry/refund behavior and durable checkpoints. See
[the audit](PLAYER-CONNECTION-AUDIT.md). This supersedes historical single-player
lease, 15-second wait, and Enable sound instructions below. No deployment requested.

## Official PH components for admin and attendee (2026-11-05)

The user requested a new dark UI effort from consolidated `origin/main`, using
the official https://components.purduehackers.com/ skill and React components.
This supersedes the dashboard visual identity requirement for `/admin` and
`/queue` only. Keep current copy and functionality, especially minimal attendee
requests and organizer queue controls/loading guards. `/display`, its visualizer,
player, and existing dashboard identity remain outside this redesign. Scope all
new theme/reset styles to the two UI routes. No production changes or deployment.

Approval recorded: the user said “i approve” on 2026-10-30 after reviewing the
consolidated plan and adding the display/server/PH ID clarifications. The scope
and defaults in [APPROVAL-PLAN.md](APPROVAL-PLAN.md) are adopted. Start phase 1;
do not ask for the same approval again. Questions below are the historical
discovery record where the approved plan has supplied a default.

Updated 2026-10-30 after the user's return and first answers. Repository ownership,
audio-only presentation, and song-versus-mix interruption are now substantially
clearer. The user subsequently chose another 15 minutes of master playback after
requested music rather than fixed clock slots. Exactly one request plays per turn;
PH ID and three songs per person per night are confirmed. The wall has two
independent monitors, and dashboard changes are outside scope. The user also chose
automatic requests, admin-managed night sessions, waiting a new interval after an
empty turn, and Firefox. Latest answers confirm the empty-turn reset example,
elapsed time during pause/buffering, accepted-submission quota, and technical
failure refunds. Remaining defaults were adopted through the consolidated plan approval.

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
  six minutes is still a song. Approved user requests must be strictly under six minutes.
- Audio only: no video should be downloaded, streamed, or embedded, including a
  hidden video fallback. Research `youtube-dl`/`yt-dlp`-style audio sourcing.
- Build in its own Purdue Hackers repo, `purduehackers/jukebox`, with all jukebox
  routes under the intended jukebox hostname. No jukebox domain/deploy exists yet.
- Match the dashboard's exact fonts, colors, borders, and dithering. The dashboard
  is a visual reference rather than an integration target or implementation home.
- The user's [display sketch](references/display-sketch.png) supplies the starting
  composition: large left audio visualization, now-playing/artwork below it, queue
  sidebar on the right with a request QR area toward its bottom.
- The visualization must analyze/listen to the real playing audio and render it
  with dithering. It is not merely decorative shader motion. Exact signal path,
  shader adaptation, geometry, and rendering responsibilities are deferred to the
  display-phase discussion. The sketch is guidance, not a finalized mockup.
- PH ID has an existing repo/codebase (`purduehackers/id`) to inspect/reuse in the
  identity phase. The user reports an existing capable server to consider for
  relevant hosted workloads; specifications/access/deployment are not verified.
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
  refund technical playback failures. Approved defaults also refund preparation
  failures, do not automatically refund deliberate admin removals/skips, and
  enforce the strict under-six-minute request limit.
- Valid requests join automatically, without per-song admin approval. Admins may
  remove requests. Validation failures and source preparation are not approval gates.
- Work locally first, split the project into discussion/implementation phases,
  then deploy after understanding existing infrastructure.

## Discovery questions — superseded by approved defaults where applicable

Do not repeat these as a new general question batch. Refer to the approved plan;
defer real technical choices to their component phases and report evidence.

1. **Scheduling:** Exactly one request per turn, with the song/mix rule and a new
   15-minute elapsed master period afterward. Empty turns reset the interval;
   pausing/buffering does not stop it. Handling a deliberately paused due turn is
   settled by the approved plan: mark due and wait for organizer resume.
   A seek must not silently count skipped media as listening time.
2. **Worker location:** The user asked for a researched recommendation rather
   than selecting either option. Proposed: hosted media worker in production,
   the same worker locally for development, subject to phase-1 hosting-network
   source tests and engineer runtime/storage input. The hosted architecture is
   approved; the concrete server/provider and spend remain later decisions.
3. **Playback source:** Audio-only sourcing is required; a visible/hidden video
   player is ruled out. Which launch link types need metadata matching, and how
   should ambiguous Spotify/Apple matches be resolved?
4. **Quota accounting:** PH ID, three songs, and admin-managed night sessions are
   settled, as are accepted-submission counting and technical failure refunds.
   Remaining defaults and organizer authorization follow the approval plan.
5. **Display details, deferred:** Two independent monitors, Firefox, the rough
   sketch composition, and real audio-driven dithering are confirmed. Use the
   dashboard heavily as a visual reference during this discussion. Exact listener,
   shader, OS/resolution, server/browser responsibilities, and Lunar placement
   remain deferred; do not reopen whether audio response is required.
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
  retries and return to master after failure; the plan approval adopted that behavior.
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
- Real music-reactive dithering is required. Discuss its exact audio analysis,
  visual geometry, shader processing, responsiveness, pause/silence behavior, and
  rendering location during the display phase; decorative motion is insufficient.
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
| D04 | Request cadence | One user song, then 15 elapsed minutes in master; pauses/buffering count; empty turns reset interval | Due-while-paused and recovery defaults approved |
| D05 | Provider and cross-service matching | Audio-only confirmed; implementation under research | No video fallback; resolve links separately |
| D06 | Repo/service/hosting ownership | Separate org repo confirmed and created | `purduehackers/jukebox`; runtime/hosting still open |
| D07 | Identity and quota | PH ID; three accepted submissions/person/admin-managed night; technical failures refunded | Removal/skip and session-end defaults approved |
| D08 | Moderation and failure behavior | Automatic requests; admin removal confirmed | Failures, skips, and quota effects remain open |
| D09 | Wall/Lunar/visualizer layout | Two monitors, rough sketch, and real audio-reactive dithering confirmed | Detailed listener/shader/layout and Lunar placement deferred |
| D10 | Existing dashboard integration | Outside scope | Dashboard is a visual reference; no changes or cross-dashboard coordination |
| D11 | Visual identity | Confirmed | Match exact dashboard tokens/assets and dithering |
| D12 | Audio worker placement | Hosted architecture approved; evaluate existing server first | Run the same worker locally first; verify intended hosting network; no new paid hosting yet |
| D13 | Display browser | Firefox confirmed | Validate actual target codec, activation, seek, and recovery behavior |
| D14 | Existing server | User reports capable existing server | Evaluate its actual resources/access before proposing new hosting |

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

During review, the user supplied a display sketch, clarified that the dithering
must visualize real playing audio, noted the existing PH ID repo/code, and said
the existing server is capable. They explicitly deferred detailed discussion of
those components to their phases. The next user message, “i approve”, approved
the consolidated plan with those additions and authorized phase 1. Paid hosting
and production deployment remain later steps.

When a decision is made, record the user's answer, date, rationale, and affected
phase. Avoid silently resolving open questions through implementation defaults.


## Phase-1 implementation evidence (2026-10-30)

The [local playback proof and measured findings](PHASE-1-FINDINGS.md) now exist.
This is technical evidence, not a new user product decision: strict YouTube
audio-only acquisition succeeded locally for an hour mix and short request;
Firefox interrupt/resume and playing-media analysis worked. The worker/page use
a minimal experiment stack, not the later full application. Existing-server
source reliability, venue HDMI, production source operation, matching, and secure
shared contracts remain unverified. No dependent phase has started.


## Phase-2 implementation record (2026-10-30)

The user said “sure move to next” after the phase-1 report; phase 2 implemented the
[shared contract and durable local service](PHASE-2-CONTRACT.md). It applies the
confirmed rules and approved defaults. These **implementation choices** filled gaps
and remain open to user revision (none was asked as a product question):

- Runtime: TypeScript on Node (type stripping) + SQLite, single process; Python
  worker stays the media boundary.
- Only prepared (`ready`) requests count when a turn falls due; a still-preparing
  request makes the turn empty.
- Duplicate rule covers `preparing`/`ready` requests (“waiting”), keyed by playable recording.
- PH ID `organizer`/`admin` roles grant Jukebox admin, plus an explicit allowlist.
- Lease 15 s, heartbeat 5 s (≤ 5 s replay after a crash), unconfirmed after 10 s;
  same-device second tab needs explicit takeover.
- Bounded retries: 2 preparation attempts, 2 playback loads per request, master item
  unusable after 2 failures.
- Master may play outside an open night; requests require one. Night close archives a
  playing request without refund (the quota period ends).

Not established: live PH ID sign-in (no client registered), Firefox against this
service (phase 3), real-source resolve through the new endpoint, existing-server fit.

## Phase 4C component discussion (2026-10-30)

Confirmed by the user after the visual proposals: scrolling envelope A; supplied
PolySans Slim, PolySans Slim Italic and PixelHackers assets; real thumbnails;
requests plus next master; 1920×1080 monitor; Lunar kept separate. See
[display implementation and verification](PHASE-4C-DISPLAY.md) for the signal,
rendering choices and pending venue checks. Shared metadata/assets/SSE additions
remain integration proposals in `proposals/phase-4c*.md`.

## Phase-4B implementation record (2026-10-30)

The user said “start the next phase and its agents” after the phase-2 report; phase 4B built the attendee
[`/queue` page and Spotify/Apple matcher](PHASE-4B-QUEUE.md). Not new user decisions; **implementation
choices** open to revision: a read-only `request.preview` plus an `expectRecordingKey` guard (proposed to the
contract owner); match ambiguity is resolved by the attendee choosing a YouTube link, never silently; rough
"about N minutes" estimates instead of an ETA; no self-withdrawal until its quota effect is decided.
Still unverified: live PH ID, live Spotify/Apple/YouTube search, a physical phone scanning a QR.

## Phase-3 implementation record (2026-10-30)

The [designated Firefox player and measured findings](PHASE-3-FINDINGS.md) implement
pairing, explicit claims, local activation, desired-state reconciliation, actual
reports and local lease expiry. Shared contracts and server semantics are unchanged.
**Implementation choice:** every successful claim waits a full 15-second lease
before audio, even ordinary claims, to cover a disconnected player after admin
revocation. Reports renew the new lease while waiting. The frame explains this
startup delay. This extends the same-device takeover safety wait without granting
other devices permission to steal a live lease.

Firefox/local-worker recovery evidence is recorded separately from pending audible,
HDMI, wall and actual laptop sleep/wake checks. Final display design remains phase
4C; venue/server/production integration remains phase 5.

## PH ID live local verification (2026-11-02)

The user supplied a `/queue` screenshot signed in as `patiowizard` following the
PH ID token transport fix. Record this as user-observed live local sign-in;
organizer/admin permissions are pending their PH ID role grant, then a fresh
login. The user requested that future DNS/operator questions be retained;
[Deployment handoff](DEPLOYMENT-HANDOFF.md) records hosting/server evaluation,
DNS target and approval procedure, HTTPS/ingress, durable storage, PH ID production
callback/credential ownership, and rehearsal gates. No infrastructure choice,
production change, or external outreach was made.

## Display simplification (2026-11-01)

The user requested removing the “Mix will pause, then resume” caption, the entire
next-master panel, and the local-preview phone-reachability notice from `/display`.
This supersedes the earlier next-master presentation choice; the queue gets the
freed sidebar space. Playback scheduling and QR destination behavior are unchanged.

## Session-driven display (2026-11-01)

The user rejected the manual display-pairing/claim workflow and requested a laptop
that follows admin session start/end automatically, asking for browser sound
permission on page open when needed. This supersedes the earlier pairing UI and
master-outside-session behavior. No session: an empty display saying an admin
needs to start one. Starting a session starts the prepared master (or waits for
its preparation); ending clears the display and stops audio.

Implementation choice: automatic page-scoped player credentials and a single
background lease keep competing tabs from producing duplicate music. The first
connected display plays; others stay silent and connect if it closes/expires.
The page attempts Web Audio activation immediately, offers only **Enable sound**
when blocked, and retains that activation through session changes/reconnects in
the same document. A fresh document still follows Firefox's autoplay permission.
The QR and now-playing strip share a grid row; QR size matches the artwork size.


## Consolidated local app (2026-11-02)

The user authorized consolidating the uncommitted display/session/player work and
all admin revisions from “Audio Visualizer Symmetry and Bounce” with the PH ID
checkout, committing and pushing them. `feat/jukebox-phid` is the working app;
`feat/jukebox-integration` follows the combined baseline. Preserve both the newer
automatic session flow and prior phase-3 reliability fixes: stale snapshots cannot
undo a connection; terminal acknowledgements retain silent heartbeats; reconnects
reuse a valid audio graph; each new connection waits out a full old lease before
playing. The latter can delay initial music by up to 15 seconds, with no pairing UI.
See [PH ID setup](PH-ID-SETUP.md) for the separately verified live sign-in.


Consolidation verification: `./scripts/check` passed 15 Python worker tests,
5 policy tests, 108 TypeScript tests, both typechecks, and the production build.
Isolated Firefox runs passed 16 player checks, 15 display checks, and 47 admin
checks including the 390 px layout. Fixture browsers used dedicated null audio
sinks; the user's current PH ID credentials and saved app data were not replaced.

## Link compatibility implementation follow-up (2026-11-02)

**User scope:** fix real YouTube/Spotify/Apple track links locally; preserve audio
only, PH ID, the single Firefox player and existing scheduling. No production
deployment. The coordinator accepted raising the three submission URL gates to
2048 characters; the queue-controls owner implements those shared-validator edits.

**Implementation choices:** canonical single-recording YouTube links discard
radio/list/time context; full recordings start at zero. Real worker + live matcher
is the default regardless of auth provider, with explicit offline fixture flags.
Public Spotify embed metadata (schema checked, replaceable) and Apple's public
exact-ID iTunes lookup avoid mandatory new credentials. Optional Spotify Web API
client credentials select its documented metadata API. Metadata is never audio;
a bounded YouTube search and conservative matching precede audio-only preparation.

Research, adapter interfaces, startup, measured Firefox evidence and provider
limitations are in [LINK-COMPATIBILITY.md](LINK-COMPATIBILITY.md). The reported
`yL-4oSQwzJI` recording is a 3,443-second mix: appropriate for master music and
ineligible for attendee requests. This is a duration policy result, not a playlist.

## Queue playback controls (2026-11-02)

The user asked for a simple way to play only the user queue, to play one request on demand, to pick
between admin/master/user-queue playback, and to change the interval. Design and contract:
[proposal](proposals/queue-playback-controls.md); implementation notes in
[Phase 2 contract](PHASE-2-CONTRACT.md#queue-playback-controls-2026-11-02) and [Phase 4A](PHASE-4A-ADMIN.md#queue-controls).

**Confirmed by the user in this chat** (each chosen from options, recommended defaults noted):
1. **Requests only with nothing ready: wait silently.** No master fallback, no automatic return to Auto.
2. **Explicit admin actions cut in immediately**, including over an ordinary master song (this was *not* the
   recommended option). The song is suspended and resumes at its saved position. Automatic turns keep the
   "ordinary songs finish" rule unchanged.
3. **Interval edits apply to the running countdown** (`due = periodStartedAt + new interval`).
4. **Mode resets to Auto when a night opens or closes; the interval setting persists** across nights.

**Defaults I chose to fill gaps (not asked; open to revision):** labels `Auto` / `Master only` / `Requests only` and
`Play now`; a request that is already playing is never cut off by a mode change (finishes first); `Play now`
is refused while a request plays; Auto after Master only starts a fresh interval with no catch-up turn; a
deliberate pause stays paused through `Play now`/mode changes (the request loads and waits for Play); `Play now` and
mode changes never change allowance; interval bounds 1–120 minutes (service-enforced); `Requests only` plays
requests back to back by explicit organizer choice, while Auto keeps exactly one request per turn.

## Queue UI simplification (2026-11-02)

The user requested moving mode/interval controls into the admin Queue section,
updating link entry for YouTube/Spotify/Apple Music, and immediate add-progress
feedback with duplicate-click prevention. Display source badges now say
“Master Queue” or “Request Queue”, with yellow distinguishing requests.

The attendee page should omit wait estimates, scheduling/policy explanations,
match-reason bullets, redundant catalog metadata above the match, and all comments
under personal request cards (including thanks and removal/refund explanations).
Use “Search” and “Found match:”, retain the exact-YouTube-link alternative, and
provide Cancel to reset the form. Quota and scheduling enforcement remain unchanged.
The user explicitly requested a few agents and focused, short verification rather
than extensive test runs. Intermittent catalog-to-YouTube audio resolution for the
two supplied Spotify links is a separate reliability investigation.

Matching duration tolerance: the user rejected the prior few-second bound and
requested one or two minutes. Apply a one-minute absolute tolerance, retaining
title/artist/version checks and the actual under-six-minute request limit.

Implementation: the matcher tries at most two qualifying uploads if the first
fails specifically to expose an audio-only format; it does not cache that failure.
Bounded live checks retrieved both Spotify tracks' metadata but encountered a
YouTube search HTTP 403 for Someday and connection errors during Little Darling
extraction. Those observations do not establish the precise cause of the user's
successful retry. UI/behavior checks were focused; both typechecks passed.
Changes are applied to the running local PH ID app, without committing or pushing.

## Consolidated main baseline (2026-11-05)

The user requested publishing the current combined app to `main` so other agents
start from the latest implementation. This includes the queue/admin copy and
loading fixes, display badges, one-minute matching tolerance and bounded alternate
upload resolution, and automatic private `.env.local` loading. Phase branches are
historical sources, not the default baseline. The separate `feat/jukebox-ph-ui`
redesign is not included in this promotion and must incorporate current main
before integration. This is a source-code consolidation, with no deployment or
credential/state publication.

Admin copy cleanup (2026-11-05): remove the stale-time caption, offline status
explanation, request-turn detail sentence, add-link guidance, mode explanation,
and default-interval reset button per the user-highlighted screenshot.

## Current dark UI promoted to main (2026-11-05)

The user requested making the running dark PH-components UI, including the
latest highlighted-copy removals, the consolidated main baseline for subsequent
chats. The official component skill and scoped admin/queue styles are included;
display/player/server behavior stays unchanged. Real PH ID configuration and
service/worker state remain local and untracked. Typechecks and build pass; the
13 focused admin/rendering checks passed after the copy cleanup.

## Approved stationary soundbar promoted to display (2026-11-05)

The user approved the original stationary soundbar's reaction and pasted all 14
settings, archived verbatim in `references/soundbar-approved-settings.json`.
The user ultimately rejected the wisp, extra gradient, outline, cutout and warp
experiments and explicitly requested putting their original on `/display` and
pushing it to `main`. Those experimental renderers/controls/dependencies are
removed. Do not restore them without a new user request.

The display uses the exact approved defaults, independent of browser lab storage.
The soundbar integrates FFT power into stationary logarithmic bands, maps a dB
range to height, applies the approved attack/release and renders one mirrored
scalar field through 4x4 Bayer dithering in purple/black. FFT 4096 with native
analyser smoothing disabled; explicit reaction smoothing is the only temporal
filter. No autonomous motion, particle layers or shader warp remains. First/last
measured heights meet the panel side edges without synthetic triangular taper.

`/visual` retains only the original 14 tuning sliders, Reset, Copy settings and
underlying-function toggle. It uses the same renderer as `/display`. Changing lab
sliders does not change the display's approved preset. Use one live player page
at a time; `/visual?silent=1` and display fixtures mount no player. The renderer
only consumes the existing player analyser and creates no audio graph/session.
PH ID, scheduling, checkpoints, QR and admin/queue styling remain unchanged.

Research findings remain in VISUALIZER-RESEARCH.md as background, not overrides
to the user-approved settings. Original source formulas and the final approved
preset take precedence over proposed research defaults.


Validation for promotion: 179 automated tests, both TypeScript checks and the
production build pass. Firefox 159 verified the actual DisplayView fixture's
shared renderer with muted cached audio: exact approved JSON, real audio response,
silence decay, original purple Bayer pixels, flush sides and preserved QR panel.
The test fixture mounts no live player and changes no night/queue/checkpoint.
The user reconfirmed that `/visual` should remain for future work.

## Implementation reconciliation and deployment scan (2026-11-06)

The user requested a final localhost review, deployment readiness scan, and notes
that reflect how the app actually works. CURRENT-STATUS.md now consolidates the
implemented behavior and later overrides without treating them as new decisions.
Baseline reviewed: `32c265a`, already on `origin/main`; local main was behind.
The normal stack was started with real PH ID and the real audio worker. Full
routine checks pass (179 TS, 21 Python, five policy tests, typechecks/build).
Public deployment remains blocked by stale SSE authorization and the unprotected
public automatic-display reporting/registration boundary, plus unfinished hosting,
persistence/backup, production-origin identity/source and venue checks. This scan
authorizes no production or DNS change and does not restore obsolete pairing UX.

The fresh Firefox 159.0 run passed all 16 native playback/recovery checks with
isolated fixtures and a null audio sink, including concurrent displays, repeated
nights, outages and refund recovery. Mix resume seek error measured 0.000 seconds.
Evidence: `evidence/deployment-scan-firefox.json`. HDMI and server-source tests
remain pending; these results do not close the public-deployment gates.

## Shorter display countdown label (2026-11-06)

The user requested removing “turn” from the display countdown. Its visible label
and accessible section name now read “Next request”; scheduling is unchanged.
