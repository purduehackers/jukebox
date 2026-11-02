import copy
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
from jukebox.media import validate_source, validate_selection, duration_ok, probe
from jukebox.server import byte_range, make_server
from jukebox.store import Store, EMPTY, Conflict


class SourcePolicy(unittest.TestCase):
    def test_allowed_links_and_rejections(self):
        self.assertEqual(validate_source('https://youtu.be/BaW_jenozKc'), 'https://www.youtube.com/watch?v=BaW_jenozKc')
        self.assertEqual(validate_source('https://youtu.be/TqTNaPB-4ow?si=uSH13mmOtwOR5z35'), 'https://www.youtube.com/watch?v=TqTNaPB-4ow')
        for url in ['https://youtu.be/TqTNaPB-4ow?si=x&si=y', 'https://youtu.be/TqTNaPB-4ow?si=', 'http://youtube.com/watch?v=BaW_jenozKc', 'https://youtube.com.evil/watch?v=BaW_jenozKc',
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
                base=line.split('proof: ')[1].removesuffix('/display')
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


if __name__ == '__main__': unittest.main()
