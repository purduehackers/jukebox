# Phase 4B: attendee request queue (`/queue`)

Implemented 2026-10-30 on `feat/jukebox-queue` (parent `feat/jukebox-app-shell` @ `c2dc883`).
Scope authority: [APPROVAL-PLAN.md](APPROVAL-PLAN.md); contract: [PHASE-2-CONTRACT.md](PHASE-2-CONTRACT.md).
Labels: **Confirmed** = user decision/approved default; **Implementation choice** = filled a gap;
**Limitation** = known gap. Contract changes are *proposals* in [proposals/phase-4b.md](proposals/phase-4b.md).

## What exists

| Piece | Path |
| --- | --- |
| Attendee page (phone-first, silent) | `app/src/queue/QueuePage.tsx`, `queue.css` (dashboard tokens, sharp purple-bordered panels) |
| Request flow state machine (framework-free) | `app/src/queue/controller.ts` |
| Wording, request states, timing estimates | `app/src/queue/model.ts` |
| QR origin rule | `app/src/queue/origin.ts`, `scripts/queue-qr.ts` |
| Spotify/Apple matcher behind `SourcePort` | `src/adapters/matching-core.ts`, `matching-source.ts`, `matching-fixtures.ts` |
| Contract proposals (P1–P3) | commits prefixed `contract-proposal:` |

## Attendee flow

1. **Sign in.** The page links to `/auth/login?returnTo=/queue`. Locally that is the fake sign-in; the real
   PH ID client is **not registered**, so live sign-in has never run (see limitations).
2. **Paste and check.** `request.preview` (proposal P1) resolves the link without reserving allowance and
   returns the title/artist/duration, the matched recording for Spotify/Apple links, and a **verdict**
   (accepted / too long / duplicate). The page offers *Add to queue* only for an accepted verdict.
3. **Submit.** `request.submit {url, expectRecordingKey}` with a `commandId` bound to (canonical link,
   recording) and kept until the server gives a final answer. Double taps join one in-flight call; a lost
   response, retry, or reload (sessionStorage retry aid only) replays the same command, so allowance is
   charged once. If the link now resolves to a different recording than previewed → `GUARD_MISMATCH`, nothing
   admitted, the user must check again.
4. **Track.** Own requests (from the role-scoped snapshot, so two clients agree) show a state, what it means
   for the allowance, and a rough turn estimate. Everyone sees the shared lineup (titles only; no names or
   others' links).

Every `ErrorCode` has attendee wording (`ERROR_COPY` is an exhaustive `Record<ErrorCode,…>`, so a new code
fails the type check until it has copy). Request states: preparing "Getting ready", ready "In line", playing,
played, failed "refunded", removed/skipped "still counts", archived "night ended first".

### Timing honesty (**Implementation choice**)
No exact ETA. The page says "roughly N minutes" rounded up to 5, from the elapsed-time schedule
(`periodStartedAt + periodMs`, plus each request ahead and the 15 minutes after it), and always adds that
it can come sooner or later. It shows no number when a turn is due but held (paused/offline/song ending) or
the master clock has not started. It cannot know the remaining length of the current master song, whether
requests ahead get removed/reordered, or that a request still *preparing* at its turn is passed over.

### Visibility limit (**Limitation**)
The snapshot (phase 2) lists a requester's *finished* entries only for one hour after they finish; allowance
counts remain correct. An attendee returning later in a long night will not see old played entries.

## Spotify / Apple matching

A Spotify/Apple URL is metadata, not audio. `MatchingSource(inner, catalog, search)` implements `SourcePort`:
YouTube/fixture links go straight to the inner source; Spotify/Apple links are matched.

- `CatalogPort.lookup(ref)` → title, artists, duration (needs Spotify app credentials / Apple developer
  token — **not available**). `CandidateSearchPort.search(track)` → up to 10 YouTube candidates (**not built
  live**; would need a bounded worker search or the YouTube Data API). Both have fixture implementations;
  `UnconfiguredCatalog` fails with `SOURCE_UNSUPPORTED` and says matching is not configured.
- A candidate must match title (whole words, version markers and "official audio/video" noise removed on
  both sides) **and** artist, have the same hard version markers (live, remix, acoustic, instrumental, karaoke,
  cover, sped up, slowed, …), and a duration within max(3 s, 2 %). Soft markers (remaster, explicit, …) are
  reported, not blocking. The chosen candidate is re-resolved by the inner source and its duration re-checked.
- Several strong candidates: prefer YouTube "- Topic" uploads, then the artist's channel; if the best tier
  contains different edits (> 3 s apart) → `ambiguous`; equivalent uploads → first result, reason shown.
- No strong candidate → `version_mismatch` (other versions found) or `no_match`, as
  `SOURCE_UNAVAILABLE` with structured `details` (candidates, notes). The page lists up to three and lets the
  attendee pick one, which only fills in a YouTube link and re-checks. **Nothing is ever substituted silently.**
- The request keeps the requested URL (`sourceUrl`) and catalog title/artist; `recordingKey` and duration are
  the matched recording's, so the same recording via Spotify, Apple, and YouTube is one duplicate. Match
  provenance is kept in the stored `selection`. Candidates are never fetched or downloaded by matching.
- **Limitation:** thresholds are heuristics validated only against fixtures; real catalogs (live albums,
  regional titles, non-Latin scripts, Topic uploads missing) need tuning against real data once credentials exist.
  Fixture durations and candidates are invented; the only real fact is that Spotify track
  `1OAFmguvHB2OI2AMYXpmyG` is *A New Kind Of Love (pt. 1)* by Ghost Funk Orchestra (public page metadata).

## QR / test origin

`queueEntryUrl(origin)` returns `<origin>/queue` and refuses loopback (`localhost`, `127.x`, `::1`, `0.0.0.0`),
credentials, non-http(s), and plain http on public hosts (private LAN http is allowed for tests).
`node scripts/queue-qr.ts --origin <origin> [--png file]` validates, checks `/healthz` and `/queue` answer, then
prints the URL and a QR (`qrencode`, argument array, no shell). The display phase can import `queueEntryUrl`.
**Not tested from a phone**: the dev service binds loopback only. For a real phone test run the app on a
reachable address (LAN `--host`, or an approved tunnel), set `JUKEBOX_ORIGIN` to exactly that origin (the
same-origin CSRF check compares it), and use the script. Do not expose the fake-auth service publicly.

## Run it

`./scripts/run-dev --fixture-matching` (service :8980 + Vite :5173; adds fixture Spotify/Apple matching),
then open `/queue`, sign in with any `sub` (an `organizer` role can open a night via `night.open`, or `/admin` once phase 4A lands).
Demo links: `https://youtu.be/DEMOsong001`, `https://youtu.be/DEMOlong001` (over six minutes),
Spotify `…/track/1OAFmguvHB2OI2AMYXpmyG` (clean match), `…/track/CCCCCCCCCCCCCCCCCCCCCC` (ambiguous),
`…/track/AAAAAAAAAAAAAAAAAAAAAA` (only other versions exist), Apple `https://music.apple.com/us/song/a-new-kind-of-love/1000000000001`.

## Evidence (2026-10-30)

- `./scripts/check` passes (see report for counts). New tests: `queue-flow` (new/returning user, double tap and
  lost response, reload resume, night spanning local midnight, 16 unsupported/malicious URLs with no resolver
  calls, overlong, mismatched version, admin removal no refund, preparation/playback failure refund, two
  clients), `queue-http` (two attendees + organizer over HTTP/SSE through the matcher), `queue-model`
  (all error codes, states, timing, QR origin, reachability), `matching`, `preview`.
- Real **Firefox 158** (headless, Selenium, phone-width window) against the fixture service: sign-in via fake
  PH ID, preview with match, **double-click on Add → one entry, 2 of 3 left**, overlong shows no Add button,
  ambiguous list → "Use this one" → preview, malicious/unsupported/"only other versions" messages, a second
  session sees the same lineup. Screenshots: [evidence/phase-4b/](evidence/phase-4b/).
- Not exercised: a physical phone, live PH ID, live Spotify/Apple/YouTube, real audio (fake media), screen
  readers, slow networks, > 2 simultaneous real browsers.

## Limitations and open items

- Real PH ID sign-in unverified; no Jukebox client registered (phase 2 status unchanged).
- Live Spotify/Apple catalog access and live YouTube candidate search do not exist; the live path is
  unconfigured and reports so. Matching accuracy on real catalogs is unmeasured.
- Preview/submit resolve twice (resolver cost); previews are rate limited to 12/min/identity in memory.
- Withdrawal/replacement of one's own request is **not** implemented: its quota rules are not set.
- No push/“your song is next” notification; the page updates over SSE while open.
- Fonts: body uses the shared token font stack; PixelHackers/Whyte are owned by the display phase.
