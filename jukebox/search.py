"""Bounded YouTube video search: flat metadata only, never media downloads."""
import json
import math
import re
import sys


def search(query):
    import yt_dlp
    # A caller cannot supply an extractor URL/options: the search prefix is ours.
    if not isinstance(query, str) or not 1 <= len(query) <= 300 or any(ord(c) < 32 for c in query):
        raise ValueError('Search requires a short title and artist')
    options = {'extract_flat': True, 'skip_download': True, 'playlistend': 10,
               'socket_timeout': 10, 'retries': 0, 'extractor_retries': 0,
               'quiet': True, 'noprogress': True, 'cachedir': False,
               'remote_components': [], 'js_runtimes': {'node': {}}}
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info('ytsearch10:' + query, download=False)
    return candidates(info)


def candidates(info):
    result = []
    for item in (info.get('entries') or [])[:10]:
        if not isinstance(item, dict) or not re.fullmatch(r'[A-Za-z0-9_-]{11}', str(item.get('id', ''))):
            continue
        duration = item.get('duration')
        if item.get('live_status') in ('is_live', 'is_upcoming') or item.get('is_live'):
            continue
        if not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
            continue
        title, channel = item.get('title'), item.get('channel') or item.get('uploader')
        if not isinstance(title, str) or not isinstance(channel, str):
            continue
        result.append({'url': 'https://www.youtube.com/watch?v=' + item['id'],
                       'title': title[:500], 'channel': channel[:300], 'durationSec': duration})
    return result


if __name__ == '__main__':
    try:
        print(json.dumps(search(sys.argv[1])))
    except Exception:
        # Don't forward upstream URLs/headers/cookies in error messages.
        print('YouTube candidate search failed', file=sys.stderr)
        sys.exit(1)
