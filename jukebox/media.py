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
    if source in FIXTURES:
        return source
    if not isinstance(source, str) or len(source) > 300:
        raise ValueError('Unsupported source; use a fixture or a single YouTube watch link')
    p = urlsplit(source)
    if p.scheme != 'https' or p.username or p.password or p.port or p.fragment:
        raise ValueError('Only canonical HTTPS YouTube track links are supported')
    q = parse_qs(p.query, keep_blank_values=True)
    # YouTube's ordinary share links carry an opaque `si` attribution token.
    # It is not media identity; accept only this narrow extra field and discard it.
    if 'si' in q:
        if len(q['si']) != 1 or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', q['si'][0]):
            raise ValueError('Invalid sharing parameter')
        del q['si']
    if p.hostname in ('youtube.com', 'www.youtube.com') and p.path == '/watch' and set(q) == {'v'} and len(q['v']) == 1:
        item = q['v'][0]
    elif p.hostname == 'youtu.be' and not q:
        item = p.path[1:]
    else:
        raise ValueError('Unsupported provider/path; playlists and metadata matching are deferred')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{11}', item):
        raise ValueError('Invalid YouTube item ID')
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
