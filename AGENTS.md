# Purdue Hackers Jukebox

## Architecture

- Separate app (`purduehackers/jukebox`) for `jukebox.purduehackers.com`, serving
  `/display`, `/admin`, `/queue`, and `/visual`. The existing Hack Night dashboard
  (`purduehackers/hack-night-dashboard`) is a visual reference only; do not modify
  or couple to it.
- Astro owns pages, middleware, and route injection; Bun runs the HTTP transport
  and SQLite queue authority (`src/server/`); the local Python worker (`jukebox/`)
  handles `yt-dlp` resolution, download, and FFmpeg validation behind `src/adapters/worker.ts`.
- Shared contract types and validation live in `src/contract/`; URL parsing and
  provider canonicalization live in `src/core/sources.ts` and `jukebox/media.py`.

## Requirements

- **Audio only:** No video download, stream, embed, or hidden-video fallback. Fail
  clearly if no suitable audio-only source exists.
- **Display playback:** One venue Firefox browser produces music through HDMI.
  Admin and attendee pages stay silent and sync via authoritative server state.
  `/display` and `/visual` require organizer PH ID login. Playback auto-pauses
  if open displays drop to 0 (after the reload grace window) and stays paused on
  reopen until an organizer presses Play.
- **Scheduling:** Ordinary master songs (≤ 360 s) finish before a due request;
  master tracks > 360 s are mixes that interrupt and resume at their saved
  position. Exactly one user request plays per turn, followed by a 15-minute
  master interval (configurable 1–120 min). Elapsed time counts during pauses
  and buffering; seeks do not move the period timer; empty turns reset the
  interval.
- **Requests & quota:** Attendees sign in with Purdue Hackers ID (3 requests per
  admin-managed night session when quota is enabled, strictly < 360 s). Accepted
  submissions count toward quota; technical preparation/playback failures refund
  automatically.
- **Display visuals:** Keep the Hack Night dashboard fonts, token colors, borders,
  and audio-reactive dithered soundbar (`docs/jukebox/references/soundbar-display-settings-2026-11-09.json`),
  with the sketch layout (`docs/jukebox/references/display-sketch.png`).
- **UI scope:** `/admin` and `/queue` use `.agents/skills/purdue-hackers-ui/SKILL.md`
  with dark mode and minimal copy. Do not apply global UI resets to `/display`.

## Implementation rules

- Keep scheduling, catalog matching, media preparation/cache, and browser
  playback as separate responsibilities.
- Validate source URLs and worker limits server-side in both `src/core/sources.ts`
  and `jukebox/media.py`. Never interpolate submitted URLs into shell commands.
- Keep suspended master assets pinned in the worker cache while requests play,
  and clean up unused/failed assets within the cache budget.
- Keep `.env.local` and `.local/` private. Do not silently enable fixture auth or
  media in normal startup.
- Use local fixtures and `FakeClock` for automated tests; do not require
  production credentials or live upstream traffic in `bun run check`.
