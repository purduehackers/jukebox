# Purdue Hackers Jukebox

## Start here

Read `docs/jukebox/README.md`, `docs/jukebox/DECISIONS.md`, and the applicable phase brief.
This is `purduehackers/jukebox`, a separate app from the Hack Night dashboard.
There is currently only documentation: no app stack, scripts, database, or
deployment has been implemented. Do not assume dashboard scripts exist here.

## Confirmed requirements

- Intended hostname: `jukebox.purduehackers.com`; routes `/display`, `/admin`,
  and `/queue` live underneath it.
- Audio only throughout the media path. No video download, stream, embed, or
  hidden-video fallback. Fail clearly if no suitable audio-only source exists.
- One designated laptop browser produces music through HDMI. Admin and attendee
  pages remain silent and communicate through shared authoritative state.
- Ordinary master songs finish before a due request. Tracks over six minutes are
  mixes that may be interrupted and must resume at their saved position. After
  requested music, allow another 15 minutes of master playback before the next
  request turn. Exactly one user song plays per turn. Attendee duration cutoff
  and timer edge cases remain open.
- Attendees must sign in with Purdue Hackers ID; the limit is three songs per
  person per admin-managed night session. Valid requests enter automatically;
  admins may remove them. Quota consumption/refunds are still open.
- The designated display browser is Firefox. Test codecs, activation, seeking,
  and any media-origin behavior in Firefox; do not infer support from Chrome.
- If a request turn is empty, wait for a new 15-minute master interval. Working
  interpretation: the empty turn resets the interval; confirm with a timing example.
- The wall has two independent monitors. The existing dashboard is only a visual
  reference: do not add widgets, edit its chat/layout, or implement cross-dashboard
  coordination as part of this scope. Jukebox's display runs on its own monitor.
- Exact Hack Night dashboard visual identity: preserve actual fonts, token color
  values, border treatment, and dithering as documented in DESIGN-REFERENCE.md.
- Work locally first; verify real audio preparation and seeking before polishing
  UI. Do not claim media/network/hardware behavior was tested from docs alone.

## Implementation discipline

- Keep user-confirmed decisions, proposals, and open questions distinct. Update
  the decision log when the user answers; their latest instructions take priority.
- Keep scheduling, link metadata/matching, media preparation/cache, and browser
  playback as separate responsibilities. A Spotify/Apple URL is not itself audio.
- Shared queues/checkpoints must survive supported restarts and concurrent clients.
  Browser storage, module memory, or Edge Config alone is not queue authority.
- Use stable command IDs, actual player acknowledgement, and explicit device
  authority. A public display page must not silently claim venue playback.
- Keep the suspended master mix's audio asset pinned while requests play. Delete
  unused assets with bounded cache/cleanup behavior, including failed jobs/crashes.
- Use local source/auth/player fixtures and a test clock for routine verification.
  Do not require production credentials or source traffic for automated tests.
- Validate source URLs/providers and worker limits server-side. Never interpolate
  submitted URLs into a shell command. Keep source-specific tooling replaceable.
- Read related repos' own instructions before edits. DNS belongs to
  `purduehackers/dns`. Changes to the existing dashboard are outside this scope.
- New phase chats must bind to this repo/project with the appropriate committed
  parent baseline. Use isolated worktrees and stable shared contracts for parallel
  phases; assign one integration owner for shared schemas and migrations.

The docs include research against the dashboard and related org repos. Paths
such as `src/components/dash/dash.tsx` in those findings refer to the reference
dashboard repository, not files that already exist in this one.
