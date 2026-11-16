"""Source policy and local asset inspection, independent of player/timing policy."""
import json
import math
import re
import subprocess
from urllib.parse import parse_qs, urlsplit

MAX_DURATION = 4 * 3600
MAX_ASSET_BYTES = 256 * 1024 * 1024
FORMAT = 'bestaudio[vcodec=none][acodec!=none][protocol=https]/bestaudio[vcodec=none][acodec!=none][protocol=http]'
FIXTURES = {'fixture:master': (3600, 220), 'fixture:request': (4, 660),
            'fixture:song': (360, 330), 'fixture:aac': (8, 440)}


def validate_source(source):
    if not isinstance(source, str) or len(source) > 2048:
        raise ValueError('Use a single YouTube recording link')
    source = source.strip()
    if source in FIXTURES:
        return source
    if re.search(r'[\\\x00-\x20\x7f]', source) or re.match(r'https://[^/]*:', source):
        raise ValueError('Use a plain HTTPS link without a port')
    p = urlsplit(source)
    hosts = ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be')
    if p.scheme != 'https' or p.username or p.password or p.port or p.hostname not in hosts:
        raise ValueError('Only HTTPS YouTube recording links are supported')
    if re.match(r'https://([^/?#]+)', source, re.I).group(1).lower() != p.hostname:
        raise ValueError('Use a plain provider hostname')
    # Only the recording ID matters. Every query parameter and the fragment are
    # navigation/tracking context (si, drli, utm_*, redirects, #t=...): they are
    # discarded, never validated or forwarded, because the canonical URL is rebuilt
    # from the ID alone.
    q = parse_qs(p.query, keep_blank_values=True)
    if p.hostname != 'youtu.be' and p.path == '/watch':
        item = q.get('v', [''])[0]  # first v wins when duplicated
    elif p.hostname == 'youtu.be':
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


def validate_selection(info, kind):
    if info.get('_type', 'video') != 'video' or info.get('is_live') or info.get('live_status') in ('is_live', 'is_upcoming'):
        raise ValueError('Only completed individual recordings are supported')
    duration_ok(info.get('duration'), kind)
    if info.get('vcodec') != 'none' or info.get('acodec') in (None, 'none') or info.get('requested_formats'):
        raise ValueError('No verified audio-only source format; combined/video media is forbidden')
    if info.get('protocol') not in ('https', 'http'):
        raise ValueError('This proof requires a direct audio-only HTTP file')
    if (info.get('filesize') or info.get('filesize_approx') or 0) > MAX_ASSET_BYTES:
        raise ValueError('Source exceeds per-job byte limit')


def probe(path, kind):
    p = subprocess.run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,crypto,data',
                        '-show_streams', '-show_format', '-of', 'json', str(path)],
                       capture_output=True, text=True, timeout=20, check=True)
    data = json.loads(p.stdout)
    streams = data.get('streams', [])
    if len(streams) != 1 or streams[0].get('codec_type') != 'audio':
        raise ValueError('Asset rejected: exactly one audio stream and zero video/other streams required')
    duration = float(data['format']['duration'])
    duration_ok(duration, kind)
    return {'duration': duration, 'codec': streams[0]['codec_name'],
            'streams': [{'type': s['codec_type'], 'codec': s['codec_name']} for s in streams]}
