import contextlib
import io
import sys
import unittest
from unittest.mock import patch
from jukebox.resolve import main


class ResolveClients(unittest.TestCase):
    def run_resolve(self, fail_fast=False):
        import yt_dlp
        options = []
        class Client:
            def __init__(self, opts): options.append(opts)
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def extract_info(self, source, download):
                self_url = 'https://www.youtube.com/watch?v=e-ORhEE9VVg'
                assert source == self_url and download is False
                if fail_fast and len(options) == 1:
                    raise yt_dlp.utils.DownloadError('Requested format is not available')
                return {'id': 'e-ORhEE9VVg', 'title': 'Song', 'duration': 272,
                        'vcodec': 'none', 'acodec': 'opus', 'protocol': 'https', 'format_id': '251'}
        with patch.object(yt_dlp, 'YoutubeDL', Client), patch.object(sys, 'argv', ['resolve', 'https://www.youtube.com/watch?v=e-ORhEE9VVg', 'request']), contextlib.redirect_stdout(io.StringIO()):
            main()
        return options

    def test_fast_client_never_downloads_and_retains_audio_only_policy(self):
        options = self.run_resolve()
        self.assertEqual(len(options), 1)
        self.assertEqual(options[0]['extractor_args']['youtube']['player_client'], ['visionos'])
        self.assertIn('vcodec=none', options[0]['format'])

    def test_default_clients_remain_fallback_for_same_recording(self):
        options = self.run_resolve(True)
        self.assertEqual(len(options), 2)
        self.assertNotIn('extractor_args', options[1])
        self.assertEqual(options[0]['format'], options[1]['format'])
