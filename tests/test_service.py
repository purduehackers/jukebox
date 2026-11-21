import copy
import http.server
import json
from pathlib import Path
import subprocess
import sys
from unittest.mock import patch
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid
from jukebox.media import validate_source, validate_selection, validate_identity, duration_ok, probe
from jukebox.prepare import prepare
from jukebox.server import byte_range, make_server
from jukebox.store import Store, EMPTY, Conflict


class SourcePolicy(unittest.TestCase):
    def test_allowed_links_and_rejections(self):
        self.assertEqual(validate_source('https://youtu.be/BaW_jenozKc'), 'https://www.youtube.com/watch?v=BaW_jenozKc')
        self.assertEqual(validate_source('https://youtu.be/TqTNaPB-4ow?si=uSH13mmOtwOR5z35'), 'https://www.youtube.com/watch?v=TqTNaPB-4ow')
        # Duplicate or empty tracking params are discarded context, not errors; only the ID is checked.
        self.assertEqual(validate_source('https://youtu.be/TqTNaPB-4ow?si=x&si=y'), 'https://www.youtube.com/watch?v=TqTNaPB-4ow')
        self.assertEqual(validate_source('https://youtu.be/TqTNaPB-4ow?si='), 'https://www.youtube.com/watch?v=TqTNaPB-4ow')
        self.assertEqual(validate_source('https://music.youtube.com/watch?v=TqTNaPB-4ow&si=uSH13mmOtwOR5z35&drli=1'), 'https://www.youtube.com/watch?v=TqTNaPB-4ow')
        for url in ['http://youtube.com/watch?v=BaW_jenozKc', 'https://youtube.com.evil/watch?v=BaW_jenozKc',
                    'https://youtube.com:443/watch?v=BaW_jenozKc', 'https://user@youtube.com/watch?v=BaW_jenozKc',
                    'https://www.youtube.com/playlist?list=x', 'https://localhost/file.mp3',
                    'file:///tmp/a.mp3', 'https://open.spotify.com/track/x', '$(touch /tmp/untrusted)',
                    'https://www.youtube.com/watch?v=BaW_jenozKc;touch /tmp/untrusted']:
            with self.subTest(url=url), self.assertRaises(ValueError): validate_source(url)

    def test_audio_only_selection_before_download(self):
        valid = dict(duration=42, vcodec='none', acodec='opus', protocol='https')
        validate_selection(valid, 'request')
        for patch in [{'vcodec':'avc1'}, {'vcodec':None}, {'acodec':'none'}, {'protocol':'m3u8_native'},
                      {'requested_formats':[{}]}, {'is_live':True}, {'duration':None}, {'duration':360},
                      {'filesize':300*1024*1024}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError): validate_selection({**valid,**patch}, 'request')
        duration_ok(360,'master')
        duration_ok(359.999,'request')
        for value in [float('nan'),float('inf'),-1,0,20000]:
            with self.assertRaises(ValueError): duration_ok(value,'master')

    def test_soundcloud_audio_only_and_preview_policy(self):
        http_mp3 = dict(id='12345', duration=180, vcodec='none', acodec=None, ext='mp3',
                        protocol='http', format_id='http_mp3_128', extractor_key='Soundcloud',
                        webpage_url='https://soundcloud.com/dj/track')
        hls_opus = dict(id='12345', duration=180, vcodec='none', acodec='opus', ext='opus',
                        protocol='m3u8_native', format_id='hls_opus_64', extractor_key='Soundcloud',
                        webpage_url='https://soundcloud.com/dj/track')
        validate_selection(http_mp3, 'request', 'soundcloud')
        validate_selection(hls_opus, 'request', 'soundcloud')
        validate_identity(http_mp3, 'https://soundcloud.com/dj/track', 'soundcloud')
        for patch_data in [
            {'format_id': 'hls_mp3_128_preview'},
            {'format_id': 'http_mp3_128_preview'},
            {'vcodec': 'avc1'},
            {'acodec': 'none'},
            {'acodec': None, 'ext': 'wav'},
            {'protocol': 'rtmp'},
            {'duration': 360},
            {'requested_formats': [{}]},
        ]:
            with self.subTest(patch=patch_data), self.assertRaises(ValueError):
                validate_selection({**http_mp3, **patch_data}, 'request', 'soundcloud')
        for bad_id in [
            {'id': 'not-numeric'},
            {'extractor_key': 'Youtube'},
            {'webpage_url': 'https://evil.test/dj/track'},
        ]:
            with self.subTest(bad_id=bad_id), self.assertRaises(ValueError):
                validate_identity({**http_mp3, **bad_id}, 'https://soundcloud.com/dj/track', 'soundcloud')

    def test_ranges(self):
        for value, expected in [(None,(0,99,False)),('bytes=20-29',(20,29,True)),('bytes=95-',(95,99,True)),
                                ('bytes=-5',(95,99,True)),('bytes=0-1000',(0,99,True))]:
            self.assertEqual(byte_range(value,100),expected)
        for value in ['bytes=100-','bytes=9-1','bytes=-0','bytes=0-1,5-9','bytes=-','cats=0-9']:
            with self.assertRaises(ValueError): byte_range(value,100)

    def test_stream_probe_rejects_synthetic_video_and_partial(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'reject.mkv'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=size=16x16:duration=0.1',
                            '-c:v','ffv1',str(path)],check=True)
            with self.assertRaises(ValueError): probe(path,'master')
            path.write_bytes(b'partial broken audio')
            with self.assertRaises(subprocess.CalledProcessError): probe(path,'master')


class CacheCheckpoint(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(self.temp.name)
        # Deterministic cache metadata fixtures, not claiming these bytes play.
        for item,kind,duration in [('m','master',3600),('r','request',4),('u','master',20)]:
            directory = self.store.assets / item
            directory.mkdir(); (directory/'asset.webm').write_bytes(b'audio-bytes')
            receipt = dict(kind=kind,duration=duration,file='asset.webm',mime='audio/webm',bytes=11)
            self.store.db.execute('insert into assets values(?,?,?)',(item,json.dumps(receipt),time.time()))
        self.store.db.commit()
        self.token = str(uuid.uuid4())
        self.store.claim(self.token)

    def tearDown(self):
        self.store.close(); self.temp.cleanup()

    def test_pin_interrupt_resume_cas_idempotency_and_restart(self):
        state = {**copy.deepcopy(EMPTY),'masterId':'m','requestId':'r','role':'request',
                 'masterPosition':1234.567,'position':1.25,'commandId':'interrupt-1'}
        ack = self.store.checkpoint(self.token,0,state)
        self.assertEqual(self.store.checkpoint(self.token,0,state)['revision'],ack['revision'])
        for item in ('m','r'):
            with self.assertRaises(Conflict): self.store.delete(item)
        with self.assertRaises(Conflict): self.store.claim(str(uuid.uuid4()))
        with self.assertRaises(Conflict): self.store.checkpoint(self.token,0,{**state,'position':2})
        self.store.close(); self.store = Store(self.temp.name)
        self.assertEqual(self.store.player()['state']['masterPosition'],1234.567)
        self.assertEqual(self.store.references(),{'m','r'})
        state.update(role='master',requestId=None,position=1234.567,commandId='resume-1')
        self.store.checkpoint(self.token,ack['revision'],state)
        self.store.delete('r')
        self.assertFalse((self.store.assets/'r').exists())
        self.store.ttl = -1
        self.store.cleanup()
        self.assertEqual([a['id'] for a in self.store.listing()['assets']],['m'])

    def test_backlog_bounds_and_crash_cleanup(self):
        # Stop the worker so the backlog remains deterministic.
        self.store.stop.set(); self.store.thread.join()
        for _ in range(4): self.store.submit('fixture:request','request')
        with self.assertRaises(Conflict): self.store.submit('fixture:request','request')
        (self.store.work/'partial').mkdir(); (self.store.work/'partial'/'input.part').write_bytes(b'partial')
        (self.store.assets/'orphan').mkdir()
        self.store.close(); self.store = Store(self.temp.name)
        self.assertFalse(list(self.store.work.iterdir()))
        self.assertFalse((self.store.assets/'orphan').exists())
        self.assertTrue(all(j['status']=='failed' for j in self.store.listing()['jobs']))

    def test_job_deadline_and_partial_cleanup(self):
        self.store.job_seconds = .15
        directory = self.store.work/'timeout'; directory.mkdir()
        start = time.monotonic()
        with self.assertRaisesRegex(ValueError,'timed out'):
            self.store.run_job([sys.executable,'-c','import time; time.sleep(30)'],directory)
        self.assertLess(time.monotonic()-start,2)


    def test_byte_limit_and_cache_pressure_preserve_pins(self):
        directory = self.store.work/'oversized'; directory.mkdir()
        with patch('jukebox.store.MAX_ASSET_BYTES',4096):
            with self.assertRaisesRegex(ValueError,'byte/log limit'):
                self.store.run_job([sys.executable,'-c',
                    'from pathlib import Path; import time; Path("'+str(directory/'input.part')+'").write_bytes(b"x"*8192); time.sleep(30)'],directory)
        state={**copy.deepcopy(EMPTY),'masterId':'m','requestId':'r','commandId':'pins'}
        self.store.checkpoint(self.token,0,state)
        self.store.max_bytes=22
        self.store.cleanup()
        self.assertEqual(self.store.references(),{'m','r'})
        self.assertFalse((self.store.assets/'u').exists())

    def test_real_service_crash_recovers_unpublished_job(self):
        with tempfile.TemporaryDirectory() as tmp:
            process=subprocess.Popen([sys.executable,'-m','jukebox.server','--port','0','--data',tmp],stdout=subprocess.PIPE,text=True)
            try:
                line=process.stdout.readline().strip()
                base=line.split('worker: ')[1].removesuffix('/display')
                request=urllib.request.Request(base+'/api/prepare',data=json.dumps({'source':'fixture:master','kind':'master'}).encode(),headers={'Content-Type':'application/json'})
                with urllib.request.urlopen(request) as response: job=json.load(response)
                deadline=time.monotonic()+5
                while time.monotonic()<deadline:
                    if list((Path(tmp)/'work').rglob('input.*')): break
                    time.sleep(.1)
                else: self.fail('Worker never started')
                process.kill();process.wait(timeout=5)
                time.sleep(.2)  # allow Linux parent-death signal to terminate job group
                recovered=Store(tmp)
                try:
                    self.assertEqual(recovered.listing()['jobs'][0]['status'],'failed')
                    self.assertEqual(recovered.listing()['assets'],[])
                    self.assertFalse(list(recovered.work.iterdir()))
                finally: recovered.close()
            finally:
                if process.poll() is None: process.kill();process.wait()
                process.stdout.close()


class RealPreparationHTTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.store = Store(cls.temp.name)
        job = cls.store.submit('fixture:aac','request')
        deadline = time.monotonic()+40
        while time.monotonic()<deadline:
            j = cls.store.listing()['jobs'][0]
            if j['status']=='failed': raise AssertionError(j['error'])
            if j['status']=='ready': break
            time.sleep(.1)
        else: raise AssertionError('fixture preparation timed out')
        cls.item = job['id']; cls.asset = cls.store.asset(cls.item)
        cls.server = make_server(cls.store,0)
        cls.thread = threading.Thread(target=cls.server.serve_forever,daemon=True); cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(); cls.store.close(); cls.temp.cleanup()

    def test_range_head_bytes_etag_and_if_range(self):
        url = self.base+self.asset['url']
        full = urllib.request.urlopen(url).read()
        self.assertGreater(len(full),1000)
        self.assertEqual(self.asset['streams'],[{'type':'audio','codec':'aac'}])
        for header,expected in [('bytes=5-14',full[5:15]),('bytes=-15',full[-15:]),('bytes=100-',full[100:])]:
            response=urllib.request.urlopen(urllib.request.Request(url,headers={'Range':header}))
            self.assertEqual(response.status,206); self.assertEqual(response.read(),expected)
            self.assertEqual(response.headers['Accept-Ranges'],'bytes')
        response=urllib.request.urlopen(urllib.request.Request(url,method='HEAD',headers={'Range':'bytes=0-9'}))
        self.assertEqual(response.status,206); self.assertEqual(response.read(),b'')
        self.assertEqual(response.headers['Content-Length'],'10')
        response=urllib.request.urlopen(urllib.request.Request(url,headers={'Range':'bytes=0-9','If-Range':'"old"'}))
        self.assertEqual(response.status,200); self.assertEqual(response.read(),full)
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(urllib.request.Request(url,headers={'Range':'bytes=999999999-'}))
        self.assertEqual(cm.exception.code,416); cm.exception.close()

    def test_api_validation_origin_and_delete(self):
        for data,headers in [({'source':'https://evil.invalid/a','kind':'request'},{}),
                             ({'source':'fixture:request','kind':'request'},{'Origin':'https://evil.invalid'})]:
            request=urllib.request.Request(self.base+'/api/prepare',data=json.dumps(data).encode(),headers={'Content-Type':'application/json',**headers})
            with self.assertRaises(urllib.error.HTTPError) as cm: urllib.request.urlopen(request)
            self.assertEqual(cm.exception.code,400); cm.exception.close()
        url=self.base+'/media/00000000-0000-0000-0000-000000000000'
        with self.assertRaises(urllib.error.HTTPError) as cm: urllib.request.urlopen(url)
        self.assertEqual(cm.exception.code,404); cm.exception.close()


class WorkerAPI(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.store=Store(self.temp.name)
        self.server=make_server(self.store,0); self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
        self.base=f'http://127.0.0.1:{self.server.server_port}'
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.store.close(); self.temp.cleanup()
    def post(self,path,data):
        request=urllib.request.Request(self.base+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json'})
        try:
            with urllib.request.urlopen(request,timeout=3) as response: return response.status,json.load(response)
        except urllib.error.HTTPError as error:
            try: return error.code,json.load(error)
            finally: error.close()
    def test_fixture_resolve_and_request_duration_rejection(self):
        status,result=self.post('/api/resolve',{'source':'fixture:request','kind':'request'})
        self.assertEqual(status,200); self.assertEqual(result,{'source':'fixture:request','id':'request','title':'request','artist':None,'duration':4,'recordingKey':'fixture:request'})
        status,result=self.post('/api/resolve',{'source':'fixture:song','kind':'request'})
        self.assertEqual(status,400); self.assertFalse(result['retryable']); self.assertIn('six minutes',result['error'])
    def test_retention_order_pins_delete_cleanup_and_restart(self):
        retained=str(uuid.uuid4()); other=str(uuid.uuid4())
        self.assertEqual(self.post('/api/retention',{'revision':4,'assets':[retained]})[1],{'revision':4,'assets':[retained]})
        self.assertEqual(self.post('/api/retention',{'revision':3,'assets':[other]})[1],{'revision':4,'assets':[retained]})
        directory=self.store.assets/retained; directory.mkdir(); (directory/'asset.webm').write_bytes(b'a')
        self.store.db.execute('insert into assets values(?,?,?)',(retained,json.dumps({'kind':'request','duration':4,'file':'asset.webm','mime':'audio/webm','bytes':1}),time.time()))
        self.store.db.commit()
        with self.assertRaises(Conflict): self.store.delete(retained)
        self.store.ttl=-1; self.store.cleanup(); self.assertTrue(directory.exists())
        self.store.close(); self.store=Store(self.temp.name)
        self.assertIn(retained,self.store.references())
        self.assertEqual(self.store.retention(0,[])['revision'],4)
    def test_job_endpoint_ready_and_failed(self):
        accepted=self.store.submit('fixture:request','request'); deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            result=self.store.job(accepted['id'])
            if result['status'] in ('ready','failed'): break
            time.sleep(.05)
        self.assertEqual(result['status'],'ready',result['error']); self.assertEqual(set(result['asset']),{'id','url','mime','codec','duration','bytes'})
        status,endpoint=self.post('/api/prepare',{'source':'fixture:song','kind':'request'})
        self.assertEqual(status,202); deadline=time.monotonic()+2
        while time.monotonic()<deadline:
            failed=self.store.job(endpoint['id'])
            if failed['status']=='failed': break
            time.sleep(.05)
        self.assertEqual(failed['status'],'failed'); self.assertFalse(failed['retryable'])
    @patch('jukebox.server.os.killpg')
    @patch('jukebox.server.subprocess.Popen')
    def test_resolve_timeout_is_retryable_and_kills_group(self,popen,killpg):
        from jukebox.server import resolve_source, ResolveUnavailable
        child=unittest.mock.Mock(pid=123); child.communicate.side_effect=subprocess.TimeoutExpired('cmd',30); popen.return_value=child
        with self.assertRaises(ResolveUnavailable): resolve_source('https://youtu.be/BaW_jenozKc','master')
        child.communicate.assert_has_calls([unittest.mock.call(timeout=30),unittest.mock.call()]); killpg.assert_called()


class PrepareCompletenessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        d = Path(cls.temp.name)

        def synth(name, duration, args):
            out = d / name
            subprocess.run(
                ['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
                 f'sine=frequency=440:sample_rate=48000:duration={duration}', *args, str(out)],
                check=True,
            )
            return out.read_bytes()

        cls.full_webm = synth('full.webm', 12, ['-c:a', 'libopus', '-b:a', '64k'])
        cls.full_m4a = synth('full.m4a', 12, ['-c:a', 'aac', '-b:a', '64k', '-movflags', 'frag_keyframe+empty_moov+default_base_moof'])
        cls.full_ogg = synth('full.ogg', 12, ['-c:a', 'libopus', '-b:a', '64k'])
        cls.full_mp3 = synth('full.mp3', 12, ['-c:a', 'libmp3lame', '-b:a', '128k'])
        cls.gapped_ogg = cls.full_ogg[:len(cls.full_ogg) // 3] + cls.full_ogg[2 * len(cls.full_ogg) // 3:]
        cls.corrupt_mp3 = cls.full_mp3[:len(cls.full_mp3) // 3] + (b'\x00' * 128) + cls.full_mp3[len(cls.full_mp3) // 2:]

        cls.hls_ts = [
            synth(f'seg{i}.ts', 3, ['-c:a', 'aac', '-b:a', '64k', '-f', 'mpegts'])
            for i in range(4)
        ]
        cls.hls_mp3 = [
            synth(f'seg{i}.mp3', 3, ['-c:a', 'libmp3lame', '-b:a', '128k', '-write_id3v1', '0', '-id3v2_version', '0', '-write_xing', '0'])
            for i in range(4)
        ]

        routes = {
            '/full.webm': ('audio/webm', cls.full_webm, True),
            '/trunc_nocl.webm': ('audio/webm', cls.full_webm[:len(cls.full_webm) // 3], False),
            '/full.m4a': ('audio/mp4', cls.full_m4a, True),
            '/trunc_nocl.m4a': ('audio/mp4', cls.full_m4a[:len(cls.full_m4a) // 3], False),
            '/gapped.ogg': ('audio/ogg', cls.gapped_ogg, True),
            '/corrupt.mp3': ('audio/mpeg', cls.corrupt_mp3, True),
        }

        def playlist(prefix, ext, count):
            lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:3', '#EXT-X-MEDIA-SEQUENCE:0']
            for i in range(count):
                lines += ['#EXTINF:3.0,', f'{prefix}/{i}.{ext}']
            lines.append('#EXT-X-ENDLIST')
            return ('\n'.join(lines) + '\n').encode()

        hls_ts = cls.hls_ts
        hls_mp3 = cls.hls_mp3

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_):
                pass

            def do_GET(self):
                if self.path in routes:
                    mime, payload, send_cl = routes[self.path]
                    self.send_response(200)
                    self.send_header('Content-Type', mime)
                    if send_cl:
                        self.send_header('Content-Length', str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    self.close_connection = True
                    return
                if self.path in ('/ts.m3u8', '/ts_fail.m3u8', '/mp3.m3u8'):
                    prefix = '/ts_fail' if self.path == '/ts_fail.m3u8' else ('/ts' if self.path == '/ts.m3u8' else '/mp3')
                    ext = 'mp3' if self.path == '/mp3.m3u8' else 'ts'
                    body = playlist(prefix, ext, 4)
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/vnd.apple.mpegurl')
                    self.send_header('Content-Length', str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                if self.path.startswith('/ts/'):
                    idx = int(self.path.split('/')[-1].split('.')[0])
                    data = hls_ts[idx]
                    self.send_response(200)
                    self.send_header('Content-Type', 'video/mp2t')
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                if self.path.startswith('/ts_fail/'):
                    idx = int(self.path.split('/')[-1].split('.')[0])
                    if idx == 2:
                        self.send_response(503)
                        self.send_header('Content-Length', '0')
                        self.end_headers()
                        return
                    data = hls_ts[idx]
                    self.send_response(200)
                    self.send_header('Content-Type', 'video/mp2t')
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                if self.path.startswith('/mp3/'):
                    idx = int(self.path.split('/')[-1].split('.')[0])
                    data = hls_mp3[idx]
                    self.send_response(200)
                    self.send_header('Content-Type', 'audio/mpeg')
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                self.send_response(404)
                self.send_header('Content-Length', '0')
                self.end_headers()

        cls.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    def _run_prepare(self, source, info_dict):
        import yt_dlp
        with tempfile.TemporaryDirectory() as work:
            with patch.object(yt_dlp.YoutubeDL, 'extract_info', lambda _self, _src, download=False: dict(info_dict)):
                return prepare(source, 'request', work)

    def _yt_info(self, path, ext, acodec, duration=12):
        return {
            '_type': 'video', 'id': 'BaW_jenozKc', 'title': 'Test YT',
            'duration': duration, 'vcodec': 'none', 'acodec': acodec,
            'protocol': 'http', 'ext': ext, 'format_id': '251' if ext == 'webm' else '140',
            'url': self.base + path,
        }

    def _sc_info(self, path, ext, acodec, protocol, duration=12):
        return {
            '_type': 'video', 'id': '123456', 'title': 'Test SC',
            'duration': duration, 'vcodec': 'none', 'acodec': acodec,
            'protocol': protocol, 'ext': ext, 'format_id': f'{protocol}_{ext}',
            'extractor_key': 'Soundcloud', 'webpage_url': 'https://soundcloud.com/dj/track',
            'url': self.base + path,
        }

    def test_rejects_truncated_gapped_and_corrupt_downloads(self):
        yt = 'https://www.youtube.com/watch?v=BaW_jenozKc'
        sc = 'https://soundcloud.com/dj/track'
        cases = [
            ('trunc_nocl_webm', yt, self._yt_info('/trunc_nocl.webm', 'webm', 'opus')),
            ('trunc_nocl_m4a', yt, self._yt_info('/trunc_nocl.m4a', 'm4a', 'aac')),
            ('hls_missing_frag', sc, self._sc_info('/ts_fail.m3u8', 'm4a', 'aac', 'm3u8_native')),
            ('gapped_ogg_opus', sc, self._sc_info('/gapped.ogg', 'opus', 'opus', 'http')),
            ('corrupt_mp3', sc, self._sc_info('/corrupt.mp3', 'mp3', 'mp3', 'http')),
        ]
        for label, source, info in cases:
            with self.subTest(case=label):
                with self.assertRaises(Exception) as ctx:
                    self._run_prepare(source, info)
                msg = str(ctx.exception).lower()
                # Incomplete/corrupt errors must stay retryable in Store.worker (never hit permanent keywords).
                for term in ('duration', 'six minutes', 'audio-only', 'combined/video', 'asset rejected',
                             'exactly one audio', 'unsupported source', 'invalid youtube', 'invalid soundcloud',
                             'only canonical', 'kind must', 'completed individual', 'live recording', 'preview'):
                    self.assertNotIn(term, msg)

    def test_accepts_complete_http_and_hls_assets(self):
        yt = 'https://www.youtube.com/watch?v=BaW_jenozKc'
        sc = 'https://soundcloud.com/dj/track'
        cases = [
            ('complete_webm', yt, self._yt_info('/full.webm', 'webm', 'opus'), 'audio/webm', 'opus'),
            ('complete_m4a_dash', yt, self._yt_info('/full.m4a', 'm4a', 'aac'), 'audio/mp4', 'aac'),
            ('hls_mpegts_aac', sc, self._sc_info('/ts.m3u8', 'm4a', 'aac', 'm3u8_native'), 'audio/mp4', 'aac'),
            ('hls_mp3_frames', sc, self._sc_info('/mp3.m3u8', 'mp3', 'mp3', 'm3u8_native'), 'audio/mpeg', 'mp3'),
        ]
        for label, source, info, mime, codec in cases:
            with self.subTest(case=label):
                receipt = self._run_prepare(source, info)
                self.assertEqual(receipt['mime'], mime)
                self.assertEqual(receipt['codec'], codec)
                self.assertGreater(receipt['bytes'], 0)
                self.assertGreaterEqual(receipt['decodedSeconds'], 11.5)

    def test_store_rejects_partial_or_mismatched_publication_and_server_checks_size(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(tmp)
            try:
                # 1) Leftover .part file alongside receipt.json is rejected as retryable failure.
                def fake_partial(_args, directory):
                    (directory / 'asset.webm').write_bytes(b'abc')
                    (directory / 'input.webm.part').write_bytes(b'part')
                    (directory / 'receipt.json').write_text(json.dumps({'file': 'asset.webm', 'bytes': 3, 'duration': 4}))

                with patch.object(store, 'run_job', side_effect=fake_partial):
                    job = store.submit('fixture:request', 'request')
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        res = store.job(job['id'])
                        if res['status'] == 'failed':
                            break
                        time.sleep(.05)
                    self.assertEqual(res['status'], 'failed')
                    self.assertTrue(res['retryable'])
                    self.assertEqual(store.listing()['assets'], [])

                # 2) Mismatched receipt byte size is rejected as retryable failure.
                def fake_mismatch(_args, directory):
                    (directory / 'asset.webm').write_bytes(b'abc')
                    (directory / 'receipt.json').write_text(json.dumps({'file': 'asset.webm', 'bytes': 999, 'duration': 4}))

                with patch.object(store, 'run_job', side_effect=fake_mismatch):
                    job = store.submit('fixture:request', 'request')
                    deadline = time.monotonic() + 5
                    while time.monotonic() < deadline:
                        res = store.job(job['id'])
                        if res['status'] == 'failed':
                            break
                        time.sleep(.05)
                    self.assertEqual(res['status'], 'failed')
                    self.assertTrue(res['retryable'])
                    self.assertEqual(store.listing()['assets'], [])

                # 3) Server verifies on-disk size matches receipt and sets private cache header.
                ok_job = store.submit('fixture:request', 'request')
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    ok_res = store.job(ok_job['id'])
                    if ok_res['status'] == 'ready':
                        break
                    time.sleep(.05)
                self.assertEqual(ok_res['status'], 'ready')
                server = make_server(store, 0)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                base = f'http://127.0.0.1:{server.server_port}'
                try:
                    with urllib.request.urlopen(base + ok_res['asset']['url']) as r:
                        self.assertEqual(r.status, 200)
                        self.assertEqual(r.headers.get('Cache-Control'), 'private, max-age=3600')
                        data = r.read()
                    self.assertEqual(len(data), ok_res['asset']['bytes'])
                    # Truncate the on-disk asset to simulate corruption on disk.
                    asset_file = store.assets / ok_job['id'] / 'asset.webm'
                    asset_file.write_bytes(data[:10])
                    with self.assertRaises(urllib.error.HTTPError) as cm:
                        urllib.request.urlopen(base + ok_res['asset']['url'])
                    self.assertEqual(cm.exception.code, 404)
                    cm.exception.close()
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join()
            finally:
                store.close()


if __name__ == '__main__': unittest.main()
