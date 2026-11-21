"""One isolated, bounded preparation process. Never accepts shell command text."""
import json
import sys
import time
import subprocess
from pathlib import Path
from .media import (
    FIXTURES, MAX_ASSET_BYTES, duration_ok, format_for, probe,
    source_provider, validate_identity, validate_selection, validate_source,
    verify_audio,
)


def _check_complete_download(directory, raw, info, transfers):
    if len(transfers) != 1:
        raise ValueError('Incomplete audio download: transfer did not finish')
    if any(p.name.endswith(('.part', '.ytdl')) or '.part-Frag' in p.name for p in directory.iterdir()):
        raise ValueError('Incomplete audio download: partial files remain')
    if not raw.is_file():
        raise ValueError('Incomplete audio download: output file missing')
    raw_size = raw.stat().st_size
    if raw_size <= 0:
        raise ValueError('Incomplete audio download: empty file')
    transfer = transfers[0]
    dl_bytes = transfer.get('downloadedBytes')
    total_bytes = transfer.get('totalBytes')
    if isinstance(dl_bytes, int) and not isinstance(dl_bytes, bool) and dl_bytes != raw_size:
        raise ValueError(f'Incomplete audio download: file size ({raw_size}) differs from transferred bytes ({dl_bytes})')
    if (isinstance(total_bytes, int) and not isinstance(total_bytes, bool)
            and isinstance(dl_bytes, int) and not isinstance(dl_bytes, bool)
            and dl_bytes != total_bytes):
        raise ValueError(f'Incomplete audio download: transferred {dl_bytes} of {total_bytes} bytes')
    filesize = info.get('filesize')
    if (info.get('protocol') in ('http', 'https')
            and isinstance(filesize, int) and not isinstance(filesize, bool)
            and filesize > 0 and raw_size != filesize):
        raise ValueError(f'Incomplete audio download: file size ({raw_size}) differs from expected bytes ({filesize})')


def prepare(source, kind, directory):
    start = time.monotonic()
    source = validate_source(source)
    provider = source_provider(source)
    directory = Path(directory)
    selection = None
    transfers = []
    if source in FIXTURES:
        seconds, frequency = FIXTURES[source]
        duration_ok(seconds, kind)
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
            validate_selection(selected, kind, provider)
            if event['status'] == 'finished':
                transfers.append({'formatId': selected.get('format_id'),
                                  'vcodec': selected.get('vcodec'), 'acodec': selected.get('acodec'),
                                  'downloadedBytes': event.get('downloaded_bytes'),
                                  'totalBytes': event.get('total_bytes'), 'status': 'finished'})
        options = {'progress_hooks': [audit], 'format': format_for(provider), 'noplaylist': True, 'socket_timeout': 15,
                   'retries': 3, 'fragment_retries': 3, 'extractor_retries': 2,
                   'skip_unavailable_fragments': False,
                   'max_filesize': MAX_ASSET_BYTES, 'concurrent_fragment_downloads': 1,
                   'js_runtimes': {'bun': {}}, 'remote_components': [],
                   'outtmpl': str(directory / 'input.%(ext)s'), 'quiet': True,
                   'noprogress': True, 'cachedir': False, 'fixup': 'never'}
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(source, download=False)
            validate_selection(info, kind, provider)  # BEFORE any media download
            validate_identity(info, source, provider)
            selection = {k: info.get(k) for k in ('id', 'format_id', 'acodec', 'vcodec', 'protocol', 'duration')}
            # Persist only non-secret evidence, never temporary media URLs/headers.
            (directory / 'selection.json').write_text(json.dumps(selection))
            ydl.process_info(info)  # use exactly the validated selection
            raw = Path(ydl.prepare_filename(info))
        _check_complete_download(directory, raw, info, transfers)
    before = probe(raw, kind)  # reject video before any remux; never strip it as a workaround
    codec = before['codec']
    containers = {'opus': ('webm', 'audio/webm'), 'vorbis': ('webm', 'audio/webm'),
                  'aac': ('m4a', 'audio/mp4'), 'mp3': ('mp3', 'audio/mpeg'),
                  'flac': ('flac', 'audio/flac')}
    if codec not in containers:
        raise ValueError('Codec not supported; no transcode fallback')
    ext, mime = containers[codec]
    output = directory / ('asset.' + ext)
    args = ['ffmpeg', '-nostdin', '-v', 'error', '-xerror', '-err_detect', 'explode',
            '-protocol_whitelist', 'file,crypto,data',
            '-i', str(raw), '-map', '0:a:0', '-vn', '-c:a', 'copy']
    if ext == 'm4a':
        raw_formats = {f.strip() for f in str(before.get('format') or '').split(',') if f.strip()}
        if raw_formats & {'mpegts', 'aac'}:
            args += ['-bsf:a', 'aac_adtstoasc']
        args += ['-movflags', '+faststart']
    remux = subprocess.run(args + [str(output)], capture_output=True, text=True, timeout=60)
    remux_err = remux.stderr.strip()
    if remux.returncode != 0 or remux_err:
        detail = remux_err[-400:] if remux_err else f'exit code {remux.returncode}'
        raise ValueError(f'Corrupt or incomplete audio input during remux: {detail}')
    final = probe(output, kind)
    decoded = verify_audio(
        output, kind,
        container_duration=final['duration'],
        expected_duration=selection.get('duration') if selection else None,
    )
    raw.unlink()
    receipt = {**final, 'source': source, 'kind': kind, 'file': output.name,
               'bytes': output.stat().st_size, 'mime': mime, 'selection': selection,
               'decodedSeconds': round(decoded, 3),
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
