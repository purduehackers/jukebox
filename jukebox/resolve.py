"""Metadata-only audio selection subprocess. Emits no upstream URLs or headers."""
import json
import sys
from .media import FORMAT, validate_selection


def main():
    import yt_dlp
    source, kind = sys.argv[1:3]
    options = {'format': FORMAT, 'noplaylist': True, 'socket_timeout': 15,
               'retries': 1, 'fragment_retries': 1, 'extractor_retries': 1,
               'max_filesize': 256 * 1024 * 1024, 'concurrent_fragment_downloads': 1,
               'js_runtimes': {'node': {}}, 'remote_components': [], 'quiet': True,
               'noprogress': True, 'cachedir': False, 'fixup': 'never', 'skip_download': True}
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(source, download=False)
    validate_selection(info, kind)
    result = {'id': info.get('id'), 'title': info.get('title'),
              'artist': info.get('artist') or info.get('track_artist') or info.get('uploader'),
              'duration': info.get('duration'), 'formatId': info.get('format_id'),
              'acodec': info.get('acodec')}
    print(json.dumps(result))


if __name__ == '__main__':
    try: main()
    except Exception as exc:
        print(json.dumps({'error': f'{type(exc).__name__}: {exc}'}), file=sys.stderr)
        sys.exit(1)
