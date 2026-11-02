import json
from pathlib import Path
import unittest
import subprocess
from unittest.mock import patch
from jukebox.media import validate_source, duration_ok
from jukebox.search import candidates
from jukebox.server import search_candidates, resolve_source, ResolveUnavailable


class SourceURLParity(unittest.TestCase):
    def test_shared_url_fixtures_and_canonical_idempotence(self):
        fixtures = json.loads((Path(__file__).parent / 'fixtures/source-urls.json').read_text())
        for url in fixtures['accepted']:
            with self.subTest(url=url):
                canonical = validate_source(url)
                self.assertEqual(canonical, 'https://www.youtube.com/watch?v=yL-4oSQwzJI')
                self.assertEqual(validate_source(canonical), canonical)
        self.assertTrue(any(300 < len(url) <= 2048 for url in fixtures['accepted']))
        with self.assertRaises(ValueError): validate_source('https://youtu.be/yL-4oSQwzJI?pp=' + 'a' * 2048)
        for url in fixtures['rejected']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_source(url)
        with self.assertRaises(ValueError): duration_ok(3443, 'request')

    def test_flat_search_filters_and_bounds_untrusted_metadata(self):
        good = {'id': 'yL-4oSQwzJI', 'title': 'Title', 'channel': 'Artist', 'duration': 180}
        info = {'entries': [good, {**good, 'id': 'https://evil'}, {**good, 'duration': float('nan')},
                            {**good, 'live_status': 'is_live'}, {**good, 'channel': None},
                            *[good] * 20]}
        result = candidates(info)
        self.assertEqual(len(result), 6)
        self.assertTrue(all(c['url'] == 'https://www.youtube.com/watch?v=yL-4oSQwzJI' for c in result))

    def test_search_subprocess_arguments_and_timeout_cleanup(self):
        with patch('jukebox.server.subprocess.Popen') as spawn, patch('jukebox.server.os.killpg'):
            spawn.return_value.communicate.return_value = (b'[]', b'')
            spawn.return_value.returncode = 0
            self.assertEqual(search_candidates('Artist $(not a shell) Title'), [])
            self.assertEqual(spawn.call_args.args[0][-2:], ['jukebox.search', 'Artist $(not a shell) Title'])
            spawn.return_value.communicate.assert_called_once_with(timeout=30)
        for query in ['', 'x' * 301, 'bad\nquery', None]:
            with self.assertRaises(ValueError): search_candidates(query)

    def test_search_timeout_kills_process_group_and_resolve_errors_keep_safe_cause(self):
        with patch('jukebox.server.subprocess.Popen') as spawn, patch('jukebox.server.os.killpg') as kill:
            spawn.return_value.pid = 12345
            spawn.return_value.communicate.side_effect = [subprocess.TimeoutExpired([], 30), (b'', b'')]
            with self.assertRaises(ResolveUnavailable): search_candidates('Artist Title')
            kill.assert_called()
        with patch('jukebox.server.subprocess.Popen') as spawn, patch('jukebox.server.os.killpg'):
            spawn.return_value.returncode = 1
            spawn.return_value.communicate.return_value = (b'', b'WARNING: upstream\n{"error":"YouTube refused https://signed.invalid/secret?token=secret"}\n')
            with self.assertRaises(ResolveUnavailable) as failure:
                resolve_source('https://youtu.be/yL-4oSQwzJI', 'master')
            self.assertIn('YouTube refused', str(failure.exception))
            self.assertNotIn('secret', str(failure.exception))

    def test_worker_duration_rejection_is_policy_error_not_transient_source_failure(self):
        with patch('jukebox.server.subprocess.Popen') as spawn, patch('jukebox.server.os.killpg'):
            spawn.return_value.returncode = 1
            spawn.return_value.communicate.return_value = (b'', b'WARNING: optional endpoint denied\n{"error":"ValueError: Requests must be strictly under six minutes"}\n')
            with self.assertRaises(ValueError) as failure:
                resolve_source('https://youtu.be/yL-4oSQwzJI', 'request')
            self.assertIn('six minutes', str(failure.exception))

    def test_no_audio_format_is_explained_without_video_fallback(self):
        with patch('jukebox.server.subprocess.Popen') as spawn, patch('jukebox.server.os.killpg'):
            spawn.return_value.returncode = 1
            spawn.return_value.communicate.return_value = (b'', b'{"error":"Requested format is not available"}\n')
            with self.assertRaises(ResolveUnavailable) as failure:
                resolve_source('https://youtu.be/yL-4oSQwzJI', 'master')
            self.assertIn('audio-only', str(failure.exception))
            self.assertIn('no video fallback', str(failure.exception))
