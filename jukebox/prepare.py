"""One isolated, bounded preparation process. Never accepts shell command text."""
import json
import sys
import time
import subprocess
from pathlib import Path
from .media import FIXTURES, FORMAT, validate_source, validate_selection, probe, MAX_ASSET_BYTES


def prepare(source, kind, directory):
    start = time.monotonic()
    source = validate_source(source)
    directory = Path(directory)
    selection = None
    transfers = []
    if source in FIXTURES:
        seconds, frequency = FIXTURES[source]
        ext = 'm4a' if source in ('fixture:aac', 'fixture:song') else 'webm'
        raw = directory / ('input.' + ext)
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
                        f'sine=frequency={frequency}:sample_rate=48000:duration={seconds}',
                        '-map', '0:a:0', '-vn', '-c:a', 'aac' if ext == 'm4a' else 'libopus',
                        '-b:a', '64k', str(raw)], check=True, timeout=120)
    else:
        import yt_dlp
        # Library API ignores personal CLI configuration. No cookies, auth, remote
        # components, thumbnails, subtitles, playlists, or video postprocessors.
        def audit(event):
            selected = event.get('info_dict', {})
            validate_selection(selected, kind)
            if event['status'] == 'finished':
                transfers.append({'formatId': selected.get('format_id'),
                                  'vcodec': selected.get('vcodec'), 'acodec': selected.get('acodec'),
                                  'downloadedBytes': event.get('downloaded_bytes'),
                                  'totalBytes': event.get('total_bytes'), 'status': 'finished'})
        options = {'progress_hooks': [audit], 'format': FORMAT, 'noplaylist': True, 'socket_timeout': 15,
                   'retries': 1, 'fragment_retries': 1, 'extractor_retries': 1,
                   'max_filesize': MAX_ASSET_BYTES, 'concurrent_fragment_downloads': 1,
                   'js_runtimes': {'node': {}}, 'remote_components': [],
                   'outtmpl': str(directory / 'input.%(ext)s'), 'quiet': True,
                   'noprogress': True, 'cachedir': False, 'fixup': 'never'}
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(source, download=False)
            validate_selection(info, kind)  # BEFORE any media download
            selection = {k: info.get(k) for k in ('id', 'format_id', 'acodec', 'vcodec', 'protocol', 'duration')}
            # Persist only non-secret evidence, never temporary media URLs/headers.
            (directory / 'selection.json').write_text(json.dumps(selection))
            ydl.process_info(info)  # use exactly the validated selection
            raw = Path(ydl.prepare_filename(info))
    before = probe(raw, kind)  # reject video before any remux; never strip it as a workaround
    codec = before['codec']
    containers = {'opus': ('webm', 'audio/webm'), 'vorbis': ('webm', 'audio/webm'),
                  'aac': ('m4a', 'audio/mp4'), 'mp3': ('mp3', 'audio/mpeg'),
                  'flac': ('flac', 'audio/flac')}
    if codec not in containers:
        raise ValueError('Codec not supported by this proof; no implicit transcode fallback')
    ext, mime = containers[codec]
    output = directory / ('asset.' + ext)
    args = ['ffmpeg', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file,crypto,data',
            '-i', str(raw), '-map', '0:a:0', '-vn', '-c:a', 'copy']
    if ext == 'm4a':
        args += ['-movflags', '+faststart']
    subprocess.run(args + [str(output)], check=True, timeout=40)
    final = probe(output, kind)
    raw.unlink()
    receipt = {**final, 'source': source, 'kind': kind, 'file': output.name,
               'bytes': output.stat().st_size, 'mime': mime, 'selection': selection,
               'preparationSeconds': round(time.monotonic() - start, 3), 'transcoded': False, 'mediaTransfers': transfers}
    (directory / 'receipt.json').write_text(json.dumps(receipt))
    return receipt


if __name__ == '__main__':
    # Linux local worker: a service crash also kills this job and its FFmpeg/EJS
    # descendants, before startup recovery removes unpublished partial files.
    if sys.platform == 'linux':
        import ctypes
        import os
        import signal
        signal.signal(signal.SIGTERM, lambda *_: os.killpg(os.getpgrp(), signal.SIGKILL))
        ctypes.CDLL(None).prctl(1, signal.SIGTERM)
        if os.getppid() == 1:
            os.killpg(os.getpgrp(), signal.SIGKILL)
    try:
        prepare(*sys.argv[1:])
    except Exception as exc:
        print(f'{type(exc).__name__}: {exc}', file=sys.stderr)
        sys.exit(1)
