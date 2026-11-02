# Local link compatibility (2026-11-02)

This work starts at consolidated `f9de59b`. It changes source adapters and local
startup, not scheduling, PH ID, player authority, admin playback controls, or
production. The integration owner combines the separately owned 2048-character
command-validation gate. Until then this branch's API retains the old 300-character
limit even though both source parsers accept up to 2048 characters.

## Reported failures and resulting behavior

The radio URL `https://www.youtube.com/watch?v=yL-4oSQwzJI&list=RDyL-4oSQwzJI&start_radio=1`
and share URL `https://youtu.be/yL-4oSQwzJI?si=8CHNKPEO_BGB5vk6` identify one
recording: `https://www.youtube.com/watch?v=yL-4oSQwzJI`. Navigation, sharing and
time context are discarded before any provider call. Playback starts at zero;
whole-recording metadata and prepared-file duration still govern admission.

Live metadata identifies **Unreal Tournament '99 Drum and bass Mix™**, by Xnot,
3,443 seconds. This is valid master music and exceeds the six-minute attendee
limit. A timestamp near its end cannot turn it into an eligible request.

A separate runtime bug selected `FakeSource`/`FakeMedia` whenever `--worker` was
omitted, including with real PH ID. An otherwise valid share link therefore
looked unavailable, and the fake assets contained no audio. Real worker/matching
is now the default; fixture media requires `--fixture-media` or
`--fixture-matching`. Authentication selection remains independent.

## Current primary-source research

Researched 2026-11-02; the distinctions below matter for operation:

- [YouTube sharing help](https://support.google.com/youtube/answer/57741?hl=en)
  documents links with start times. Jukebox deliberately ignores those times.
  The pinned [yt-dlp video extractor](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/yt_dlp/extractor/youtube/_video.py)
  recognizes watch, short share, Shorts, live, and Music URLs. Its allowlist is
  much broader than ours: Jukebox accepts only explicit YouTube hosts and recording
  paths, then hands the worker a canonical watch URL. `/live/<id>` can identify an
  archived recording; active/upcoming streams remain rejected. Playlist-only,
  channel, redirector, arbitrary-media and album-only imports remain unsupported.
- [yt-dlp EJS setup](https://github.com/yt-dlp/yt-dlp/wiki/EJS) requires a supported
  JavaScript runtime and challenge solver for full YouTube functionality. The
  worker enables Node explicitly and uses the pinned `yt-dlp[default]`/EJS package;
  it does not download remote solver components. The pinned
  [2026.10.26 release](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26)
  was the current stable release when checked. `scripts/run-local` checks that
  FFmpeg, ffprobe, and Node exist. No personal yt-dlp CLI config or cookies are used.
- [yt-dlp PO-token guidance](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)
  explains why client/network restrictions can still prevent format access.
  Installing the right runtime does not guarantee a provider will serve a file.
  There is no combined-video, hidden-player, alternate-recording, or preview-audio
  fallback. A provider restriction is an error, not evidence that a URL is malformed.
- The [yt-dlp search implementation](https://github.com/yt-dlp/yt-dlp/blob/2026.10.26/yt_dlp/extractor/youtube/_search.py)
  supports `ytsearchN:` video search. We construct `ytsearch10:` internally,
  extract flat metadata, discard live/invalid entries, and resolve only the chosen
  candidate using the audio-only resolver. Search never downloads media.
- [Spotify's documented track API](https://developer.spotify.com/documentation/web-api/reference/get-track)
  supplies title, artists, full `duration_ms`, and optional ISRC. The documented
  [client-credentials flow](https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow)
  requires a registered client ID and secret. Optional environment configuration
  selects that path. No end-user Spotify login is added.
- [Spotify embeds](https://developer.spotify.com/documentation/embeds) provide a
  public track page. Its currently returned `__NEXT_DATA__` track entity was
  inspected live and supplies exact ID, artist list and full-track duration.
  That entity schema is **not a documented stable API**. Without configured API
  credentials, the adapter reads only those validated metadata fields. It never
  uses embed playback/session state, audio previews or anonymous tokens. Schema
  changes fail clearly and recommend the documented API or a direct YouTube link.
  [oEmbed](https://developer.spotify.com/documentation/embeds/reference/oembed)
  alone does not supply the full duration needed for this match policy.
- Apple's public [iTunes Search API](https://performance-partners.apple.com/search-api)
  and [ID lookup](https://developer.apple.com/library/archive/documentation/AudioVideo/Conceptual/iTuneSearchAPI/LookupExamples.html)
  provide song ID, title, artist and full `trackTimeMillis` without a developer
  token. Exact song ID and kind must match; album results are never substituted.
  Non-US storefronts survive canonicalization; legacy regionless canonical URLs
  mean US. Apple Music-only items absent from default iTunes lookup fail honestly. Optional `JUKEBOX_APPLE_MUSIC_DEVELOPER_TOKEN`
  selects the documented [Apple Music catalog-song endpoint](https://developer.apple.com/documentation/applemusicapi/get-a-catalog-song)
  with exact ID/type and full `durationInMillis`. Its [developer token](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens)
  needs a MusicKit key and Apple Developer membership. That optional path is
  fixture-tested, not live-tested without a token; no library/private-user access
  is implemented. Preview URLs are
  ignored. No Apple developer token is required for this public path.

## Boundaries and limits

`LiveCatalog` implements `CatalogPort`; `WorkerAdapter` implements
`CandidateSearchPort` as well as the existing source/media ports. `CatalogTrack`
adds optional `provenance`. No shared command, snapshot, or database migration is
changed. Matched selections retain catalog ID/title/artists/full duration,
metadata provenance, submitted canonical catalog URL and selected YouTube URL.
The worker receives only the selected canonical recording for preparation.

Catalog requests go to fixed HTTPS provider endpoints with redirects disabled,
a 10-second deadline, a 2 MiB streamed-response cap, at most two concurrent
lookups, twenty upstream requests per minute, and a 128-entry/five-minute positive metadata cache. Optional Spotify
access tokens stay in memory and are never stored in selections or exposed to
clients. API denial does not silently fall back to another identity/path.

The worker's **loopback-only** internal `POST /api/search {query}` accepts at most
300 characters, returns at most ten video metadata candidates, and shares the
two-slot semaphore with resolution. Both run in isolated process groups with a
30-second deadline and descendant cleanup. HTTP origin/Host guards also apply.
No public service search route was added. Successful worker search/resolve
metadata is cached in the adapter for 60 seconds, at most 128 entries per cache;
preparation still independently validates the full source and actual file.

Existing title/artist, hard-version-marker, duration-tolerance, ambiguity and
Topic/artist-channel matching rules remain. The chosen recording is rechecked
against the resolved title/artist/version and duration, not just search snippets.
The catalog's full duration also rejects overlong requests before searching.
Unicode letters/numbers survive normalization. Matching remains heuristic;
unknown versions, regional metadata differences or close edits may require a
user-selected direct YouTube link. No claim of semantic audio fingerprinting.

Both URL validators reject credentials, explicit ports (including `:443`),
lookalike/encoded hosts, backslashes/control characters, unsupported paths,
duplicate query keys and non-time fragments. Only known context keys are accepted.
A shared JSON fixture covers both reported URLs, navigation, time, host/path
tricks, real playlist-only rejection and a >300-character navigation URL. Canonical
YouTube URLs reparse in both languages; all catalog canonical URLs reparse in TS.

Quota still counts accepted submissions. Parse/catalog/search/resolve failures
consume nothing; preparation/playback failures use existing refunds. The same
selected YouTube recording via Spotify, Apple or YouTube is one waiting duplicate.
Existing preview recording guards and command-ID replay remain intact.

## Startup and isolated verification

Normal local app (preserve the existing PH ID environment as documented in
[PH-ID-SETUP.md](PH-ID-SETUP.md)):

```sh
./scripts/run-dev --data .local/service
```

Without `--worker`, this reuses a reachable local worker at `:8971`, or starts
`./scripts/run-local --data .local/dev-worker`. The script cleans up only children
it started. Occupied app/service ports fail before child startup; it never stops
an existing app. `--worker URL` or `JUKEBOX_WORKER_URL` chooses an externally managed
worker; an unreachable explicitly configured worker is never silently replaced.
An old worker without the candidate-search capability produces a clear update
message and stays running. `run-service` alone expects its worker to be running; failed resolution explains
worker configuration instead of claiming that the recording was removed.

Isolated ports/state:

```sh
JUKEBOX_APP_PORT=5273 JUKEBOX_SERVICE_PORT=9980 JUKEBOX_WORKER_PORT=9971 \
  JUKEBOX_WORKER_DATA=.local/link-test-worker \
  ./scripts/run-dev --data .local/link-test-service
```

PH ID requires an exact registered callback/origin; the verification script uses
labelled fake identities only inside its isolated process. No real credentials
or session databases are copied or committed. Explicit fixture demos remain
`./scripts/run-dev --fixture-matching` / `--fixture-media`; these have no audio.
`scripts/verify-admin.py` changes only by adding `--fixture-media` to its existing
isolated service invocation (preserve the queue-controls owner's UI test edits).

Optional documented Spotify API:
`JUKEBOX_SPOTIFY_CLIENT_ID` and `JUKEBOX_SPOTIFY_CLIENT_SECRET` must both be set in
the local process environment. Use private configuration/secret entry, never chat
or committed files. Neither is needed for the tested public metadata path. Apple's optional
`JUKEBOX_APPLE_MUSIC_DEVELOPER_TOKEN` is likewise unnecessary for songs present
in public iTunes lookup; it is needed only to choose the full Apple Music API.
No developer memberships or paid infrastructure are purchased by this work.

Routine: `./scripts/check` (fixtures, no source traffic). Opt-in:

```sh
.venv/bin/python scripts/verify-links.py
.venv/bin/python scripts/verify-source.py \
  --master 'https://www.youtube.com/watch?v=yL-4oSQwzJI&list=RDyL-4oSQwzJI&start_radio=1' \
  --request 'https://youtu.be/C0ElqNDOAiA' \
  --output .local/links-source-evidence.json
```

Both use disposable data/profiles and a dedicated null audio sink. They do not
verify audible HDMI output. Evidence stays under ignored `.local/`; no provider
session pages, tokens, source media files or real databases are committed.

## Observed evidence

Routine `./scripts/check` passes **21 Python worker/source tests, 5 policy tests,
126 TypeScript tests, both typechecks and the production app build**. These use
fixtures/local state, no provider traffic or production credentials. The existing
Firefox admin regression passes **47 checks**, including its 390 px layout; the
only harness change is explicit fixture media.

| Path | Live evidence | Limit / configuration |
| --- | --- | --- |
| YouTube reported mix | Radio URL canonicalized and prepared as Opus **251**, `vcodec=none`, exactly one audio stream; **3442.641 s**, **56,327,995 bytes**, **17.464 s** preparation. Firefox **158.0.1** playback and seek passed. | Later app-level metadata extraction intermittently reported `Requested format is not available`; no video fallback. |
| Spotify public track `1OAFmguvHB2OI2AMYXpmyG` | Exact title/artist, full **274192 ms**; live bounded search selected `C0ElqNDOAiA`. Normal startup without `--worker` passed UI check → submit → ready. | Public embed schema is inspected and strict, not a stable Spotify metadata API. |
| Apple public song `1634848035` | Exact title/artist/full **274192 ms** from iTunes lookup; live matcher selected the same `C0ElqNDOAiA`. Existing Spotify entry was rejected as duplicate; quota stayed at one. | No independent second admission/download of that duplicate. Apple Music-only songs may require optional catalog API configuration. |
| Matched YouTube audio `C0ElqNDOAiA` | Real Opus **251** preparation, **274.201 s**, **4,516,146 bytes**, **8.7 s** preparation; Firefox native playback/end and analysis passed. | This is YouTube audio selected from catalog metadata, not Spotify/Apple stream or preview playback. |
| Documented Spotify Web API | Token flow/track parsing/exact ID/provenance/errors tested with fixtures. | Not live-tested: optional `JUKEBOX_SPOTIFY_CLIENT_ID` + `JUKEBOX_SPOTIFY_CLIENT_SECRET` absent. Public path tested above does not need them. |
| Documented Apple Music API | Exact storefront/song/full duration/ISRC/error handling tested with fixtures. | Not live-tested: optional `JUKEBOX_APPLE_MUSIC_DEVELOPER_TOKEN` absent. Public lookup tested above does not need it. |

The real-source Firefox proof measured mix RMS **0.05638**, request RMS
**0.01435**, saved position **1234.5 s**, and resume seek error **0.0 s**. Both
assets stayed pinned during interruption. Native request end resumed the mix;
released assets were deleted and returned 404. The known unavailable source
failed without a fallback and left no partial files. This is headless/null-sink
media evidence; audible HDMI and wall behavior remain untested.

The normal-app live test additionally confirmed both exact reported URLs reject
attendee requests with `DURATION_REJECTED` and unchanged quota, and playlist-only
URLs return `SOURCE_UNSUPPORTED`. It **did not complete its final app-master
playback assertions**: YouTube withheld the audio format on that later metadata
attempt, despite the earlier successful full preparation/Firefox proof. Earlier
attempts also observed intermittent search/metadata endpoint failures (including
an upstream 403 warning). Successes and failures are recorded separately; source
access is not guaranteed by passing parser or fixture tests. No cookies, bot-check
credentials, alternate recording, or video fallback were introduced to mask this.

Machine-readable evidence is in ignored `.local/links-source-evidence.json`,
`.local/links-app-evidence.json`, and `.local/admin-evidence.json`; the source
verification scripts recreate isolated data and do not require those files.
The source script passed; the app script currently reports its external source
block after the catalog/admission/preparation checks above. Production remains
unconfigured and the user's current app on 5173/8980 was left running.


An extra run of the **unchanged** `scripts/verify-player.py` passed its first
12 checks (including real fixture audio, master/request resume, normal-song end,
mid-request refresh, failure refund, competing display, reconnect and lease-expiry
silence/reconnect), then failed line 310: after `night.close` the display already
showed idle while its independent audio controller still reported playing at the
immediate assertion. The source branch does not edit player/controller/scheduler
code. This is reported to the integration owner as an unresolved session-end
ordering/test concern, not a passing full player suite. Evidence is in
`.local/player-firefox-evidence.json`.
