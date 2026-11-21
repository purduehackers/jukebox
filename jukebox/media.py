"""Source policy and local asset inspection, independent of player/timing policy."""
import json
import math
import re
import subprocess
from urllib.parse import parse_qs, urlsplit

MAX_DURATION = 4 * 3600
MAX_ASSET_BYTES = 256 * 1024 * 1024
FORMAT = 'bestaudio[vcodec=none][acodec!=none][protocol=https]/bestaudio[vcodec=none][acodec!=none][protocol=http]'
SOUNDCLOUD_AUDIO_EXTS = ('mp3', 'opus', 'm4a', 'ogg', 'webm', 'flac')
SOUNDCLOUD_FORMAT = (
    'bestaudio[vcodec=none][format_id!=download][format_id!*=_preview][ext~="^(mp3|opus|m4a|ogg|webm|flac)$"][protocol=https]/'
    'bestaudio[vcodec=none][format_id!=download][format_id!*=_preview][ext~="^(mp3|opus|m4a|ogg|webm|flac)$"][protocol=http]/'
    'bestaudio[vcodec=none][format_id!=download][format_id!*=_preview][ext~="^(mp3|opus|m4a|ogg|webm|flac)$"][protocol=m3u8_native]'
)
SOUNDCLOUD_RESERVED_FIRST = frozenset({
    'discover', 'stream', 'upload', 'search', 'you', 'settings', 'notifications', 'messages',
    'charts', 'stations', 'popular', 'pages', 'terms-of-use', 'imprint', 'jobs', 'pro', 'go',
    'mobile', 'creators', 'people', 'tags', 'tracks', 'sets', 'albums', 'playlists',
})
SOUNDCLOUD_RESERVED_SECOND = frozenset({
    'tracks', 'albums', 'sets', 'reposts', 'likes', 'spotlight', 'comments', 'popular-tracks',
    'followers', 'following', 'recommended',
})
FIXTURES = {'fixture:master': (3600, 220), 'fixture:request': (4, 660),
            'fixture:song': (360, 330), 'fixture:aac': (8, 440)}


def source_provider(canonical):
    if canonical in FIXTURES:
        return 'fixture'
    if canonical.startswith('https://soundcloud.com/'):
        return 'soundcloud'
    return 'youtube'


def format_for(provider):
    return SOUNDCLOUD_FORMAT if provider == 'soundcloud' else FORMAT


def validate_source(source):
    if not isinstance(source, str) or len(source) > 2048:
        raise ValueError('Use a single YouTube or SoundCloud recording link')
    source = source.strip()
    if source in FIXTURES:
        return source
    if re.search(r'(?:^|/)(?:\.|%2e){1,2}(?:/|[?#]|$)', source, re.I) or re.search(r'[\\\x00-\x20\x7f]', source) or re.match(r'https://[^/]*:', source):
        raise ValueError('Use a plain HTTPS link without a port')
    p = urlsplit(source)
    if p.scheme != 'https' or p.username or p.password or p.port or not p.hostname:
        raise ValueError('Only HTTPS YouTube or SoundCloud recording links are supported')
    if re.match(r'https://([^/?#]+)', source, re.I).group(1).lower() != p.hostname:
        raise ValueError('Use a plain provider hostname')
    host = p.hostname
    if host == 'on.soundcloud.com':
        raise ValueError('Shortened SoundCloud links are not supported; open the link and paste the full soundcloud.com track URL')
    if host in ('soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'):
        trimmed = p.path[:-1] if len(p.path) > 1 and p.path.endswith('/') else p.path
        segments = trimmed.split('/')[1:]
        if len(segments) >= 2 and segments[1].lower() in ('sets', 'albums'):
            raise ValueError('Use a single recording; playlist-only links are unsupported')
        if len(segments) in (2, 3):
            artist, track = segments[0], segments[1]
            token = segments[2] if len(segments) == 3 else None
            if (re.fullmatch(r'[A-Za-z0-9_-]{1,100}', artist)
                    and re.fullmatch(r'[A-Za-z0-9_-]{1,200}', track)
                    and artist.lower() not in SOUNDCLOUD_RESERVED_FIRST
                    and track.lower() not in SOUNDCLOUD_RESERVED_SECOND
                    and (token is None or re.fullmatch(r's-[A-Za-z0-9_-]{4,64}', token))):
                slug = f'{artist.lower()}/{track.lower()}'
                item = f'{slug}/{token}' if token else slug
                return 'https://soundcloud.com/' + item
        raise ValueError('Invalid SoundCloud track link; use a single soundcloud.com track URL')
    hosts = ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be')
    if host not in hosts:
        raise ValueError('Only HTTPS YouTube or SoundCloud recording links are supported')
    # Only the recording ID matters. Every query parameter and the fragment are
    # navigation/tracking context (si, drli, utm_*, redirects, #t=...): they are
    # discarded, never validated or forwarded, because the canonical URL is rebuilt
    # from the ID alone.
    q = parse_qs(p.query, keep_blank_values=True)
    if host != 'youtu.be' and p.path == '/watch':
        item = q.get('v', [''])[0]  # first v wins when duplicated
    elif host == 'youtu.be':
        item = p.path[1:]
    elif re.fullmatch(r'/(?:shorts|live)/[^/]+', p.path):
        item = p.path.split('/')[2]
    else:
        raise ValueError('Use a single recording; playlist-only links are unsupported')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{11}', item):
        raise ValueError('Invalid YouTube item ID')
    # Only this canonical URL crosses the process/provider boundary. Context never
    # affects duration or playback: full recording, starting at position zero.
    return 'https://www.youtube.com/watch?v=' + item


def duration_ok(duration, kind):
    if not isinstance(duration, (int, float)) or not math.isfinite(duration) or not 0 < duration <= MAX_DURATION:
        raise ValueError('Duration must be finite, positive and at most four hours')
    if kind not in ('master', 'request'):
        raise ValueError('kind must be master or request')
    if kind == 'request' and duration >= 360:
        raise ValueError('Requests must be strictly under six minutes')


def validate_selection(info, kind, provider='youtube'):
    if info.get('_type', 'video') != 'video' or info.get('is_live') or info.get('live_status') in ('is_live', 'is_upcoming'):
        raise ValueError('Only completed individual recordings are supported')
    duration_ok(info.get('duration'), kind)
    if info.get('vcodec') != 'none' or info.get('requested_formats'):
        raise ValueError('No verified audio-only source format; combined/video media is forbidden')
    if provider == 'soundcloud':
        fmt_id = str(info.get('format_id') or '')
        if '_preview' in fmt_id:
            raise ValueError('Only full SoundCloud tracks are supported; 30-second previews cannot be played')
        acodec = info.get('acodec')
        if acodec == 'none' or (acodec is None and info.get('ext') not in SOUNDCLOUD_AUDIO_EXTS):
            raise ValueError('No verified audio-only source format; combined/video media is forbidden')
        if info.get('protocol') not in ('https', 'http', 'm3u8_native'):
            raise ValueError('SoundCloud source must use an audio-only HTTP or HLS stream')
    else:
        if info.get('acodec') in (None, 'none'):
            raise ValueError('No verified audio-only source format; combined/video media is forbidden')
        if info.get('protocol') not in ('https', 'http'):
            raise ValueError('Audio-only HTTP source required')
    if (info.get('filesize') or info.get('filesize_approx') or 0) > MAX_ASSET_BYTES:
        raise ValueError('Source exceeds per-job byte limit')


def validate_identity(info, canonical, provider='youtube'):
    if provider == 'youtube':
        if info.get('id') != canonical.rsplit('=', 1)[-1]:
            raise ValueError('Resolved recording identity changed')
    elif provider == 'soundcloud':
        track_id = str(info.get('id') or '')
        if not re.fullmatch(r'\d{1,20}', track_id):
            raise ValueError('Invalid SoundCloud track ID')
        extractor = info.get('extractor_key')
        if extractor and str(extractor).lower() != 'soundcloud':
            raise ValueError('Resolved recording provider changed')
        webpage = info.get('webpage_url')
        if isinstance(webpage, str) and urlsplit(webpage).hostname not in ('soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com'):
            raise ValueError('Resolved recording host changed')


def probe(path, kind):
    p = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,crypto,data',
                        '-show_streams', '-show_format', '-of', 'json', str(path)],
                       capture_output=True, text=True, timeout=20, check=True)
    data = json.loads(p.stdout)
    streams = data.get('streams', [])
    if len(streams) != 1 or streams[0].get('codec_type') != 'audio':
        raise ValueError('Asset rejected: exactly one audio stream and zero video/other streams required')
    fmt = data.get('format') or {}
    duration = float(fmt['duration'])
    duration_ok(duration, kind)
    return {'duration': duration, 'codec': streams[0]['codec_name'],
            'format': str(fmt.get('format_name') or ''),
            'streams': [{'type': s['codec_type'], 'codec': s['codec_name']} for s in streams]}


def verify_audio(path, kind, *, container_duration, expected_duration=None):
    """Decode the entire audio stream to ensure it is complete and uncorrupted."""
    p = subprocess.run(
        ['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode',
         '-protocol_whitelist', 'file,crypto,data', '-i', str(path), '-map', '0:a:0',
         '-progress', 'pipe:1', '-f', 'null', '-'],
        capture_output=True, text=True, timeout=120,
    )
    err = p.stderr.strip()
    if p.returncode != 0 or err:
        detail = err[-400:] if err else f'exit code {p.returncode}'
        raise ValueError(f'Corrupt or incomplete audio stream: {detail}')
    out_time_us = None
    for line in p.stdout.splitlines():
        if line.startswith('out_time_us='):
            val = line.split('=', 1)[1].strip()
            if val.isdigit():
                out_time_us = int(val)
    if out_time_us is None:
        raise ValueError('Incomplete audio stream: decoded output length missing')
    decoded = out_time_us / 1_000_000.0
    if not math.isfinite(decoded) or decoded <= 0 or decoded > MAX_DURATION:
        raise ValueError('Incomplete audio stream: decoded length is out of bounds')
    if abs(container_duration - decoded) > max(2.0, container_duration * 0.02):
        raise ValueError(
            f'Incomplete audio stream: decoded length ({decoded:.2f}s) disagrees with container ({container_duration:.2f}s)'
        )
    if isinstance(expected_duration, (int, float)) and math.isfinite(expected_duration) and expected_duration > 0:
        min_expected = expected_duration - max(3.0, min(15.0, expected_duration * 0.05))
        if decoded < min_expected:
            raise ValueError(
                f'Incomplete audio stream: decoded length ({decoded:.2f}s) is shorter than expected ({expected_duration:.2f}s)'
            )
    return decoded
