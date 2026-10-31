# Audio-only pipeline research

Researched 2026-10-30. Documentation/source review only: no live extraction or
hour-long media download has been tested. `ffmpeg`/`ffprobe` are available locally;
`yt-dlp`/`youtube-dl` were not installed during this research.

## What Discord music stacks actually demonstrate

The maintained [discord.py voice example](https://github.com/Rapptz/discord.py/blob/master/examples/basic_voice.py)
has both file and stream paths: its stream flag extracts a media URL without
downloading a file, then passes that URL to FFmpeg. Its other path downloads
first. This confirms that saving a whole MP3 is not a prerequisite for bot audio.
It does not prove how Rythm or Tempo historically operated, and its sample format
fallback should not be copied for this project's stricter no-video rule.

[Lavalink](https://lavalink.dev/) is another standalone audio system, with remote
controls, events, seek, and volume. [Lavaplayer](https://github.com/lavalink-devs/lavaplayer)
describes decoding/container handling and Opus packet output suitable for Discord;
its YouTube source is now a separate plugin. This is a different implementation
family, not proof every bot uses youtube-dl. Our output is a browser and HDMI, so
we should reuse the separation of metadata, media, and controls rather than adopt
Discord voice delivery infrastructure.

The named products' proprietary historical internals were not verified. Tempo's
[own current premium page](https://tempobot.net/premium) says it removed YouTube
support. No claim that Tempo or Rythm definitely used a particular downloader is
part of this plan.

## Strictly no video

The [yt-dlp format documentation](https://github.com/yt-dlp/yt-dlp#format-selection)
defines `bestaudio` as audio-only; `bestaudio*` may contain video. For the experiment,
select audio-only formats explicitly and fail when none is available. Do not use
the default format selection or a fallback to a combined video/audio format.
Merely converting the result to audio afterward would not prove that no video
was downloaded upstream.

Validate both selected source metadata and the final asset's streams. Reject any
video stream. Do not embed a YouTube player, create a hidden video element, or use
an MP4-with-video as an “audio” source. Instrument the worker's downloads during
the feasibility check, not just the browser's requests.

## Streaming, caching, and conversion are separate choices

1. **Direct remote audio:** resolve an audio stream and let the consumer fetch it.
   Quick start and little local storage, but the browser must support the codec,
   required request headers, and origin behavior. Resume/seek must survive source
   expiry or reacquisition. A raw pipe provides no arbitrary backward seek.
2. **Audio relay:** a worker feeds audio bytes to the browser as it fetches them.
   This gives us a stable application endpoint, but a simple relay does not by
   itself create a seekable recording. Range requests and source reacquisition
   would need deliberate implementation; repeated reads may re-fetch media.
3. **Temporary seekable audio cache:** prepare an audio-only file and serve it
   through our own media endpoint. This is the recommended first experiment for
   mixes because we control its lifetime and random access. It introduces storage,
   preparation latency, cleanup, and a worker process to operate.

These tradeoffs are architectural analysis, not measured benchmark results.
The cache may be filled progressively later, but “play a growing file while
supporting arbitrary seek” is a separate feature. Begin with a completed asset
and prefetch upcoming tracks; measure preparation time before adding complexity.

The [HTTP range mechanism](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests)
supports fetching portions of a file for random-access media. Our media endpoint
should implement and test valid ranges, `206`, invalid ranges, and consistent
asset identity; range support plus compatible container indexing enables testing
browser seeks. It is not a guarantee of sample-accurate resume.

MP3 is not mandatory. Keep a compatible source audio codec when possible;
[FFmpeg streamcopy](https://ffmpeg.org/ffmpeg.html#Streamcopy) can move encoded audio
into a suitable container without decoding/re-encoding. Transcode only when target
browser compatibility requires it. The spike must test the actual laptop/browser.

Illustrative compressed-file sizes for one hour, calculated as bitrate × 3600 ÷ 8:
128 kbit/s ≈ 57.6 MB; 192 kbit/s ≈ 86.4 MB; 320 kbit/s ≈ 144 MB, excluding overhead.
These are decimal estimates, not assumed source bitrates. Full uncompressed audio
buffers are unnecessary for normal browser playback.

## Recommended first pipeline

Request link → metadata/matching → audio-only resolver → temporary audio asset →
range-capable media endpoint → browser `HTMLAudioElement` → HDMI.

The queue service should record preparation status and a stable opaque media ID,
not treat a temporary upstream URL as permanent. A suspended master mix must stay
pinned in cache while the user song plays. Save its item ID and actual position;
resume only after the audio element has loaded enough metadata to seek.

Delete an asset when nothing active, suspended, queued, or preparing still needs
it, subject to an agreed replay window. Include bounded disk usage, cleanup of
failed jobs, and startup recovery after crashes. Deleting a mix on its first
interruption would break the central resume requirement.

An owned audio source also makes a genuine Web Audio visualizer more plausible:
use the same-origin media path, or correct CORS if the worker/media origin differs.
It still needs a browser proof; no visualizer is declared working by this research.

## Worker placement and operational constraints

The normal browser cannot run `yt-dlp`/FFmpeg as server processes. Extraction needs
a worker on the laptop or hosted infrastructure. A cloud frontend and queue do not
automatically supply a reliable long-running media worker or persistent cache.
Choose placement after the user answers the helper question and hardware details.

- **Laptop helper:** keeps prepared audio at the venue and avoids repeatedly
  relaying it through cloud hosting. Requires installation/startup/update handling.
  A hosted `/display` contacting a localhost helper needs origin, browser local
  network permissions, and pairing behavior verified; do not assume it is seamless.
- **Hosted worker:** keeps the laptop browser setup simpler. Requires suitable
  compute/storage, data transfer, authentication, and measured source access from
  that hosting network. Prefer serving cached media directly rather than routing
  large files through an unrelated frontend function.

Current yt-dlp [EJS documentation](https://github.com/yt-dlp/yt-dlp/wiki/EJS) requires
an external JavaScript runtime for full YouTube support. Its
[extractor notes](https://github.com/yt-dlp/yt-dlp/wiki/Extractors) describe source
limits and failures. Treat extraction as a replaceable, maintained dependency;
test from the intended deployment network, not just a developer connection.

The official [YouTube API policies](https://developers.google.com/youtube/terms/developer-policies)
constrain separated audio/background playback. The official iframe route does
not satisfy this user's audio-only requirement. A third-party extraction route
is not an officially supported audio-only YouTube API; production source use and
service terms need to be settled rather than inferred from technical feasibility.

## Phase-1 acceptance additions

- Demonstrate zero video-media downloads from source through browser delivery.
- Test a long mix and short song: prepare, play, pause at a known position, switch,
  resume, seek, refresh, and recover. Measure preparation time and resume error.
- Inspect codec/container compatibility and real HDMI output on target hardware.
- Test source failure, no audio-only format, a partial/failed asset, and cleanup.
- Keep suspended mix data; remove genuinely unused temporary assets.
- Validate arbitrary URL rejection, worker job limits, and process arguments
  without shell interpolation before exposing source ingestion to attendees.
- Prove source matching separately; Spotify/Apple links do not automatically
  provide audio or an unambiguous matching recording.
