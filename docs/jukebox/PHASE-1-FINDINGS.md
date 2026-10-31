# Phase 1: local audio playback findings

Implemented and measured 2026-10-30, America/Indiana/Indianapolis. Parent baseline:
`36f8f1b494e6d8484089dac1d979306a20336d56`. Scope authority remains
[APPROVAL-PLAN.md](APPROVAL-PLAN.md). This is the phase-1 experiment, not the
production scheduler, authentication service, or final display.

## Result and evidence

The local worker prepared both synthetic audio and real YouTube audio-only files.
Firefox played master → exactly one request → master at its saved position using
one `HTMLAudioElement`. It sought beyond 20 minutes in an hour-long file. The
same element feeds a working Web Audio analysis path across source swaps.

Reproduce with the commands in the [root README](../../README.md). Committed,
machine-readable results:

- [Firefox fixture proof](evidence/firefox-fixtures.json): fresh-profile browser
  capabilities, observations, checkpoint recovery, and actual seek measurements.
- [Real-source proof](evidence/firefox-sources.json): source selection, worker
  transfer audit, final stream probes, preparation measurements, browser events,
  seek/resume observations, deletion, and an observed unavailable source.

These are headless **Firefox 158.0.1**, Gecko build `20261020162120`,
geckodriver `0.37.1`, on development CachyOS/Linux. They are not Chromium results.
No autoplay permission override, personal profile, browser cookies, or account
secrets were used. The separate T3 preview only inspected the diagnostic page.
These results establish decoding/playing observations and analysis samples; they
do not establish audible sound, HDMI routing, monitor performance, or venue output.

## Runtime and preparation

The spike uses Python 3.14.8, its standard-library HTTP server and SQLite,
FFmpeg/ffprobe `n9.0.2`, Node `26.11.1`, yt-dlp `2026.10.26`, and companion
`yt-dlp-ejs` `0.8.0`. Only project-local virtual-environment packages were installed.
A dependency snapshot includes the browser test tooling.

This deliberately small Python + browser JavaScript experiment does not select
or replace the approved React/TypeScript direction for the later application.
The local proof has no frontend build step and no production hosting dependency.

The maintained [yt-dlp format documentation](https://github.com/yt-dlp/yt-dlp#format-selection)
distinguishes audio-only `bestaudio` from selectors that may include video. This
worker explicitly requires `vcodec=none`, a real audio codec, and a direct HTTP(S)
file. It validates the selected metadata **before** invoking the media download.
There is no default selection, combined format, merge, video postprocessor,
thumbnail, iframe, hidden video, or alternate-recording fallback.

The [current EJS instructions](https://github.com/yt-dlp/yt-dlp/wiki/EJS) require a
supported JavaScript runtime and matching challenge scripts for full YouTube
support. Node requires at least version 22 and explicit enablement; Deno is the
recommended default runtime in those instructions. This proof explicitly enables
installed Node and installs `yt-dlp[default]` with its matching EJS package.
No runtime script download option or personal yt-dlp CLI configuration is enabled.
Future source maintenance must update the extractor and companion together.

The worker records each completed media transfer's format ID, audio/video codec
fields, and byte counts, without retaining signed URLs or headers. It then uses
[ffprobe stream/format inspection](https://ffmpeg.org/ffprobe.html) to reject
anything other than exactly one audio stream. This inspection runs **before**
remuxing and again on the final file. A combined input is rejected, not stripped
to pretend it was audio-only. Local synthetic video is generated solely for the
rejection test; no video media is acquired from sources or delivered to the player.

[FFmpeg streamcopy](https://ffmpeg.org/ffmpeg.html#Streamcopy) preserves encoded
Opus/AAC in these results. Opus/Vorbis map to WebM, AAC to fast-start M4A; MP3 and
FLAC also have explicit supported-container mappings. Only Opus/WebM and AAC/M4A
were actually exercised in Firefox. Unknown codecs fail clearly instead of
silently transcoding. Fixture generation necessarily encodes owned synthetic
samples; `transcoded: false` describes preservation of the resulting input asset
through preparation, not a claim that tone generation involved no encoding.

## Real-source results

The opt-in `scripts/verify-source.py` acquired these from the development network:

| Input | Duration | Prepared bytes | Codec/container | Source selection |
| --- | ---: | ---: | --- | --- |
| [NCS hour mix](https://www.youtube.com/watch?v=MEkaqZecpUQ) | 3634.021s | 59,853,024 | Opus/WebM | 251; `vcodec=none` |
| [DEAF KEV — Invincible](https://www.youtube.com/watch?v=K4DyBUG242c) | 207.981s | 3,531,977 | Opus/WebM | 251; `vcodec=none` |

The audited source transfers were audio-only and both final assets had one Opus
audio stream and zero video streams. Preparation took roughly 10–15 seconds for
the hour mix and 5–10 seconds for the short track in repeated development runs;
exact observations are in the source receipt JSON. Playback starts only after the
whole file is downloaded, remuxed, validated, and atomically published. There is
no promise of instant playback or progressive arbitrary seeking.

The source browser proof played actual media and measured nonzero analysis
samples for master and request. It saved master at `1234.500`, played the request,
then sought near the request's end and waited for its **native ended event** to
trigger return. This avoids waiting 3:28 in a network-dependent test; it does not
claim an uninterrupted full listening pass. The independent 4-second fixture
request plays completely without seeking.

A separate attempt at the former yt-dlp test item
[`BaW_jenozKc`](https://www.youtube.com/watch?v=BaW_jenozKc) returned
`This video is unavailable`. It published no asset, deleted partial work, and
made no video or cookie fallback. Additional exploratory acquisition succeeded
for `aqz-KE-bpKQ` (634.624s AAC, format 258, about 30.8 MB) and `jNQXAC9IVRw`
(19.021s Opus, format 251); these are secondary observations, not substitutes
for the committed end-to-end hour-mix evidence.

### User-supplied examples

After the initial proof, the user supplied a master mix and three single-song
examples. Both YouTube songs fit the strict request limit, and the actual supplied
master → request → master cycle passed in Firefox for each. These runs seek near
the request end after real playback, then use the native ended event, as above.

| Supplied example | Role | Prepared duration | Prepared bytes | Result |
| --- | --- | ---: | ---: | --- |
| [TqTNaPB-4ow](https://www.youtube.com/watch?v=TqTNaPB-4ow) | Master mix | 2232.761s (37:12.761) | 37,345,898 | Opus/WebM, audio-only format 251; Firefox resume error 0.000s |
| [BXtL6W0RXpg](https://www.youtube.com/watch?v=BXtL6W0RXpg) | Single request | 297.061s (4:57.061) | 4,973,312 | Opus/WebM, audio-only format 251; complete interrupt/end/resume path passed |
| [lPeJMoms_Ag](https://www.youtube.com/watch?v=lPeJMoms_Ag) | Single request | 173.141s (2:53.141) | 2,680,898 | Opus/WebM, audio-only format 251; complete interrupt/end/resume path passed |
| [Spotify 1OAFmguvHB2OI2AMYXpmyG](https://open.spotify.com/track/1OAFmguvHB2OI2AMYXpmyG) | Single-song metadata example | Not acquired | None | Public Spotify page identifies *A New Kind Of Love (pt. 1)* by Ghost Funk Orchestra; audio acquisition/matching not implemented or claimed |

Evidence: [first supplied pair](evidence/firefox-user-sources.json),
[second supplied pair](evidence/firefox-user-sources-2.json). The mix prepared in
8.047–12.818s, first song in 10.104s, and second song in 9.311s in these runs.
All selected/delivered assets remained audio-only. The normal `youtu.be?...si=…`
sharing field is accepted after validation and discarded on canonicalization;
other arbitrary parameters and playlist links remain rejected. The Spotify title
is public-page metadata only; no account credentials or private catalog API was used.

**Phase-1 technical source decision:** use the bounded YouTube audio-only file
adapter for this local feasibility result. The approved hosted-worker architecture
remains viable enough to evaluate on the user's existing server. Development
network success does not establish reliable access from that server, broad
YouTube availability, or an officially supported YouTube audio service. The
[YouTube policy considerations](https://developers.google.com/youtube/terms/developer-policies)
in AUDIO-RESEARCH.md remain unresolved for production operation. No production
source-access promise, infrastructure selection, or credentials are implied.

Spotify/Apple links are explicitly rejected by this media endpoint. Metadata
matching is still separate work: preserve requested version/URL, resolve catalog
metadata, compare a candidate playable recording, and surface ambiguity rather
than silently replacing it. A Spotify Web API route requires an app's credentials
and access token ([client credentials documentation](https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow));
Apple Music API requires a signed developer token and suitable developer account
([Apple documentation](https://developer.apple.com/documentation/applemusicapi/generating-developer-tokens)).
App eligibility, actual organization access, quotas, playlist permissions,
market/storefront handling, and matching accuracy were not exercised. No such
accounts/APIs may be treated as available by the next phase.

## Firefox playback, timing, and recovery

Both tested MIME/codec pairs reported support and actually decoded/played.
Opening or reloading the page stays silent. A visible activation gesture resumes
the AudioContext, obtains a local proof lease, loads metadata, seeks, starts
playback, and receives an actual media acknowledgement. The fresh-profile unactivated `play()` attempt returned `NotAllowedError`. The
evidence records that separately; it must not be generalized
to other Firefox profiles or the venue machine.

The fixture preparation took approximately 30–38s for the hour-long tone and
under a second for the short tone on this development machine. The long fixture is 3600.008s Opus; the short request is 4.008s Opus. The exact
normal-song boundary fixture is 360.000s AAC, avoiding Opus container padding
turning a nominal 360-second tone into 360.008 seconds. Validated final asset
duration is authoritative in this spike; a request at or above 360s is rejected.

The fixture test verifies:

- Pause, seek to `1234.5`, and advance elapsed time while paused: it remains
  deliberately paused. Resume then starts the due request, saving the **actual**
  paused media position before replacing `src`.
- Exactly one request ends and returns to master; another offer needs a fresh
  interval. Seeking never changes the period anchor. Ordinary masters, including
  exactly six minutes, wait for their native ended event before a due request.
- An empty turn starts a new interval even during a deliberate pause; it does
  not restart the audio. With playback running, music continues. A later request
  offer does not interrupt immediately. The small policy tests explicitly cover
  the 9:15 → 9:17 → 9:30 example and elapsed-time counting during buffering.
- Analysis follows the active source and falls to zero during pause. Native media
  volume is exposed through the local slider; no OS mixer control is claimed.
- Refresh during a request restores the same role, request position, and pinned
  master position. It requires activation and finishes that request before
  returning to master. Refresh during master likewise restores its checkpoint.
- Another fresh tab is rejected while a live tab owns the local proof lease.
  Service loss stops local audio when the next bounded checkpoint fails. A
  separate synthetic forever-pending `play()` fault is bounded at eight seconds;
  it is explicitly a fault injection, not an observed Firefox/network stall.
- A missing prepared request file gets exactly two load attempts and then returns
  to the pinned master with a fresh period. No next request is chained into that
  turn. This proof has no quota to refund; later queue accounting must act on the
  technical-failure observation.

Across the recorded fixture and real-source resume operations, the immediate
post-`seeked` `currentTime` matched the saved position with **0.000 seconds reported
error**. This is Firefox's media timeline result, not sample-accurate audible
alignment. The evidence includes metadata/load/seek latency per swap; an hour-mix
resume generally required a few hundred milliseconds locally. Those measurements
exclude some command/checkpoint time and do not measure an audible HDMI gap.

The test clock adds elapsed milliseconds to the policy clock; it does not speed
up decoding or change the source duration. The normal interval is 900,000ms.
Pausing/buffering counts, a deliberate pause blocks an interrupt, and completed
requests/empty turns re-anchor the period. This is a manual one-master/one-request
proof harness, not a full scheduler. It loops its sole master when exhausted.
Production clock reconciliation, queue transitions, skip accounting, and night
sessions remain phase 2 work. Host wall-clock changes are not reconciled here.

SQLite holds a versioned checkpoint independently of browser storage, plus the
asset/job records. Normal checkpoint updates occur each second. Interrupt capture
is explicit after pause, before source swap; a sudden crash between periodic
updates can replay up to about a second of an item. Refresh has no silent autoplay.
A request may replay its last checkpoint tail; no production request-consumption
transaction is implemented. CAS revisions reject stale writes and stable command
IDs let identical acknowledged checkpoint retries return the same revision.
This is not a claim of exactly-once execution for arbitrary production commands.

The local proof lease lasts 10s and renews through checkpoint writes; failures
have a 4s fetch deadline and pause locally. Metadata/seek/play waits are bounded,
and authority is checked again before playing after loading. Reload requests a
best-effort release; if it is lost, activation can wait up to 10s for expiry.
This is a local diagnostic ownership mechanism, not secure PH ID pairing or
production fencing for suspended/background/partitioned devices. Never expose
this service as the public queue or venue authority service.

## Cache and failures

One worker admits at most four outstanding jobs. Each isolated process has a
240s overall deadline, 15s source socket timeout, one extractor/download retry,
one fragment at a time, 1 MiB log limit, and 256 MiB total job-work threshold.
The source adapter also rejects known oversized files and durations above four
hours. Native preparation, probe, and FFmpeg operations have their own deadlines.
The process group is killed on timeout/limit/stop; Linux parent-death handling
also terminates worker descendants if the service crashes.

The cache targets a 512 MiB **media/work** budget. Before starting a job it reserves
the full job allowance, evicting unused oldest assets if necessary; if pinned
assets prevent that reservation, preparation fails clearly. A 100ms work-directory
monitor can overshoot the byte threshold by bytes written between samples; this
is bounded application behavior, not a filesystem quota. Database files and
filesystem overhead are additional. A production worker needs OS/container disk,
CPU, memory, and network quotas based on the actual server.

Active/selected master and offered/playing request references are in the same
SQLite checkpoint. Both remain pinned throughout an interruption, even if the
device disconnects. A user cannot delete a pinned asset through the API. Finishing
or failing the request unpins it; clearing the proof checkpoint unpins master.
Unreferenced files expire after one hour, or earlier under cache pressure. Pins
are never aged out merely because a lease expires. Recent completed assets remain
available for selecting until expiry/pressure/explicit deletion; no general queue
or replay library is implemented.

Publication uses a complete validated asset and atomic directory rename before
its DB record becomes visible. Failed work is removed. Startup marks unfinished
jobs failed and removes their partial files and orphan asset directories. A file
lock prevents two local service instances using the same cache. Tests kill a real
service during preparation and verify that restart publishes nothing partial.
Explicit deletion removes the DB record first, so a deletion crash leaves a
cleanable orphan. Existing open HTTP file descriptors may finish their response;
subsequent requests receive 404. File serving opens under the cache lock to avoid
racing deletion.

Range checks exercise byte-exact single ranges, suffix/open ranges, HEAD, ETag,
If-Range fallback, and 416 for unsatisfiable/malformed/multiple ranges. Firefox
then performs actual indexed-container seeks through that endpoint. Assets have
immutable opaque UUID paths and ETags; media is same-origin, with no CORS bypass.
This does not establish behavior for a future separate media origin or expired
signed delivery URLs.

Only narrow HTTPS YouTube item URLs and named owned fixtures are accepted.
Playlists, extra query parameters (except a validated, discarded `si` sharing field), userinfo, ports, local addresses, arbitrary
providers, shell-like input, live/unknown-duration sources, combined formats,
non-audio streams, and partial/unprobeable files are rejected. Submitted URLs go
through argument arrays/library APIs, never shell interpolation. API bodies are
small, mutations require JSON, Host is loopback, and foreign Origins are rejected.
This is local input discipline, not a hardened public ingress service.

## Playing-media analysis path

`HTMLAudioElement → MediaElementAudioSourceNode → AnalyserNode → destination`
works in Firefox using the same element throughout master/request swaps.
The proof measures time-domain RMS and a diagnostic dominant FFT bin. Owned tones
change from 220Hz master to 660Hz request (observed nearest FFT bins about 211Hz
and 656Hz); pause yields zero samples. Changing the native volume slider from
0.2 to 0.1 lowers the measured signal as expected. The
real-source run also records nonzero RMS on both actual music files.

No microphone, room capture, second player, full-track decoded AudioBuffer, idle
animation, shader, or final wall layout is involved. This is a usable input to
later audio-reactive dithering. That discussion still owns feature selection,
smoothing, frequency bands, dithering geometry, reduced motion, exact fonts,
shader performance, and wall dimensions. Test the future media origin's CORS and
AudioContext activation before separating it from the page origin.

## Proposed interfaces for the next contract discussion

These are recommendations informed by the proof, **not an approved production
schema**. Keep submitted-link metadata/matching, worker/cache, scheduling, and
browser playback separate.

| Responsibility | Proposed stable boundary | Evidence / remaining work |
| --- | --- | --- |
| Source adapter | `resolveAudioOnly(sourceRef, purpose, limits) → selection` or structured failure; provenance includes provider item/version | Current YouTube adapter validates one format before transfer. Metadata matching must not manufacture an audio URL. |
| Preparation | `prepare(selection) → jobId`; states `queued/preparing/ready/failed`; one immutable `assetId` on success | Actual bounded background worker, safe receipt, codec preservation, no partial publication. Add typed errors/cancellation and source refresh policy later. |
| Asset descriptor | `{assetId, url, mime, codec, durationSeconds, byteLength, seekable, provenance}` | Actual proof equivalents are `id`, `url`, `mime`, `codec`, `duration`, `bytes`, and `selection`. Add schema version, integrity/expiry strategy before remote clients. |
| Cache retention | `retain(assetId, ownerReference)` / `release(reference)`; range delivery independent of queue policy | Here references derive atomically from the single proof checkpoint. Later active, suspended, queued and preparing owners need transactional retention. |
| Browser adapter | `activate`, `load(asset, position)`, `play`, `pause`, `seek(seconds)`, `setVolume(0…1)` | Capabilities: seek/native volume and analysis for tested codecs; activation required; one element suffices. |
| Playback observation | `{deviceId, commandId, generation, assetId, status, actualPosition, duration, observedAt, error?}`; statuses include ready/playing/paused/buffering/ended/error | Distinguish HTTP acceptance, media readiness, and actual playing/seek acknowledgement. Keep scheduling outside this adapter. |
| Interruption checkpoint | `{masterItemId, masterAssetId, actualPosition, requestItemId, phase, periodAnchor, revision}` | Persist before switch; keep master pinned. Production queue transitions, consumption/refund and command acknowledgement need one integration owner/transaction design. |
| Analysis tap | A single attachable analyser/output subscription follows the currently playing element | Browser proof works; final audio features and renderer remain display-phase decisions. |

The local API is intentionally inspectable: `GET /api/status`, `POST /api/prepare`,
`/api/claim`, `/api/checkpoint`, `/api/release`, `/api/delete`, `/api/cleanup`, and
`GET/HEAD /media/<id>`. Job acceptance (202) is not readiness, and a checkpoint
acknowledgement is not evidence of audible output. No `/admin` or `/queue` exists.

## Verification commands and review

`./scripts/check` passes 11 Python service/source/cache tests and 5 Node policy
tests, plus a JavaScript syntax check. `scripts/verify-firefox.py` uses owned
fixtures only; `scripts/verify-source.py` is the explicit separate real-network
check. The committed JSON receipts identify what each browser run exercised.
A focused read-only review caught the paused-empty-turn reset ordering and an
unbounded Resume play promise. Both were corrected and covered by policy/browser
checks before handoff. No production changes resulted from the review.

## Remaining gates

- Real venue Firefox profile/OS: local activation, device pairing, HDMI mixer and
  audible output, volume, both independent monitors, sleep/wake, network loss,
  and recovery. Listen to real master/request transitions and assess gaps.
- User's existing server: verify ownership/access, supported runtime, CPU/memory,
  persistent disk/quotas, FFmpeg/Node availability, source egress/reliability,
  expected load, logs, service restart, media HTTPS/ranges, and retention capacity.
  No server access, purchase, provisioning, deployment, or DNS change occurred here.
- Production source operation/terms and cross-provider catalog/matching access.
  Development-network success for two items is not reliability across a catalog.
- Phase-2 contract discussion: durable shared queues, PH ID reuse, scheduler,
  quotas/refunds, paired-device security, command execution/reconciliation,
  production clock semantics, and transactions. This report does not start it.
- Dedicated display discussion: user's sketch, exact dashboard fonts/tokens,
  real audio-driven dithered rendering, performance on the venue laptop.

The dashboard/chat/layout were not edited. No later phase, production service,
DNS operation, or additional top-level chat was started.
