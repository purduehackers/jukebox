"""Single-local-service SQLite proof checkpoint, cache references, and bounded jobs."""
import copy
import fcntl
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from .media import MAX_ASSET_BYTES, validate_source

EMPTY = {'masterId': None, 'requestId': None, 'role': 'master', 'position': 0,
         'masterPosition': 0, 'paused': True, 'periodStarted': None, 'offsetMs': 0,
         'observation': 'idle', 'commandId': None}


class Conflict(ValueError):
    pass


class Store:
    def __init__(self, root, *, job_seconds=240, max_bytes=512*1024*1024, ttl=3600):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.file_lock = (self.root / 'service.lock').open('w')
        fcntl.flock(self.file_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.work = self.root / 'work'
        self.assets = self.root / 'assets'
        self.work.mkdir(exist_ok=True)
        self.assets.mkdir(exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.root / 'state.sqlite3', check_same_thread=False)
        self.db.execute('pragma journal_mode=WAL')
        self.db.executescript('''
          create table if not exists assets(id text primary key, receipt text, created real);
          create table if not exists jobs(id text primary key, source text, kind text, status text, error text, created real, retryable integer);
          create table if not exists player(id integer primary key, revision integer, state text, owner text, expires real);
          create table if not exists retention(id integer primary key check(id=1), revision integer not null, assets text not null);
        ''')
        if 'retryable' not in {r[1] for r in self.db.execute('pragma table_info(jobs)')}:
            self.db.execute('alter table jobs add column retryable integer')
        self.db.execute("insert or ignore into retention values(1,0,'[]')")
        self.db.execute('insert or ignore into player values(1,0,?,null,0)', (json.dumps(EMPTY),))
        # An interrupted preparation is never published. Keep valid checkpoint references.
        self.db.execute("update jobs set status='failed', error='Service restarted during preparation', retryable=1 where status in ('queued','preparing')")
        self.db.commit()
        shutil.rmtree(self.work)
        self.work.mkdir()
        valid = {r[0] for r in self.db.execute('select id from assets')}
        for path in self.assets.iterdir():
            if path.name not in valid:
                shutil.rmtree(path)
        self.job_seconds, self.max_bytes, self.ttl = job_seconds, max_bytes, ttl
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.worker, daemon=True)
        self.thread.start()

    def player(self):
        with self.lock:
            revision, state, owner, expires = self.db.execute('select revision,state,owner,expires from player').fetchone()
            return {'revision': revision, 'state': json.loads(state), 'owner': owner,
                    'expires': expires, 'serverTime': time.time()}

    def claim(self, token):
        if not isinstance(token, str) or not re.fullmatch(r'[a-f0-9-]{36}', token):
            raise ValueError('Invalid local device token')
        with self.lock:
            p = self.player()
            if p['owner'] != token and p['expires'] > time.time():
                raise Conflict('Another local proof tab owns playback; pause/release it or wait 10 seconds')
            self.db.execute('update player set owner=?,expires=?', (token, time.time()+10))
            self.db.commit()
            return self.player()

    def authority(self, token):
        p = self.player()
        if not token or p['owner'] != token or p['expires'] <= time.time():
            raise Conflict('Playback lease expired or belongs to another tab; activate locally')
        return p

    def checkpoint(self, token, revision, state):
        with self.lock:
            p = self.authority(token)
            if state == p['state'] and state.get('commandId'):
                return p  # retry of an acknowledged stable command
            if p['revision'] != revision:
                raise Conflict('Stale checkpoint; reload before activating')
            self.validate_state(state)
            self.db.execute('update player set revision=revision+1,state=?,expires=?',
                            (json.dumps(state), time.time()+10))
            self.db.commit()
            return self.player()

    def validate_state(self, state):
        if set(state) != set(EMPTY) or state['role'] not in ('master', 'request') or not isinstance(state['paused'], bool):
            raise ValueError('Malformed proof checkpoint')
        for field in ('position', 'masterPosition', 'offsetMs'):
            value = state[field]
            if not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= 1e12:
                raise ValueError('Invalid checkpoint time')
        if state['periodStarted'] is not None and (not isinstance(state['periodStarted'], (int, float)) or not math.isfinite(state['periodStarted'])):
            raise ValueError('Invalid period anchor')
        if not isinstance(state['observation'], str) or len(state['observation']) > 100:
            raise ValueError('Invalid observation')
        if not isinstance(state['commandId'], str) or len(state['commandId']) > 100:
            raise ValueError('Stable command ID required')
        for key, kind in [('masterId', 'master'), ('requestId', 'request')]:
            if state[key] is not None:
                item = self.asset(state[key])
                if item['kind'] != kind:
                    raise ValueError('Asset role mismatch')
        if state['role'] == 'request' and (not state['masterId'] or not state['requestId']):
            raise ValueError('A request needs a pinned master and request asset')
        if state['masterId']:
            master = self.asset(state['masterId'])
            current = self.asset(state['requestId']) if state['role'] == 'request' else master
            if state['masterPosition'] > master['duration']+.25 or state['position'] > current['duration']+.25:
                raise ValueError('Checkpoint exceeds actual asset duration')

    def release(self, token):
        with self.lock:
            self.authority(token)
            self.db.execute('update player set owner=null,expires=0')
            self.db.commit()

    def references(self):
        with self.lock:
            state = self.player()['state']
            pinned = {state[k] for k in ('masterId', 'requestId') if state[k]}
            row = self.db.execute('select assets from retention where id=1').fetchone()
            return pinned | set(json.loads(row[0]))

    def retention(self, revision, assets):
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
            raise ValueError('revision must be a nonnegative integer')
        if not isinstance(assets, list) or len(assets) > 1000:
            raise ValueError('assets must be an array of at most 1000 UUIDs')
        unique = []
        try:
            for item in assets:
                if not isinstance(item, str): raise ValueError
                unique.append(str(uuid.UUID(item)))
        except (ValueError, AttributeError):
            raise ValueError('assets must contain UUID strings')
        unique = sorted(set(unique))
        with self.lock:
            current, stored = self.db.execute('select revision,assets from retention where id=1').fetchone()
            if revision >= current:
                self.db.execute('update retention set revision=?,assets=? where id=1', (revision,json.dumps(unique)))
                self.db.commit()
                return {'revision': revision, 'assets': unique}
            return {'revision': current, 'assets': json.loads(stored)}

    def job(self, item):
        with self.lock:
            row = self.db.execute('select status,error,retryable from jobs where id=?', (item,)).fetchone()
            if not row: return None
            status,error,retryable = row
            result = {'id':item,'status':status,'error':error,'retryable':None if retryable is None else bool(retryable),'asset':None}
            if status == 'ready':
                asset = self.asset(item)
                result['asset'] = {key:asset[key] for key in ('id','url','mime','codec','duration','bytes')}
            return result

    def asset(self, item):
        with self.lock:
            row = self.db.execute('select receipt from assets where id=?', (item,)).fetchone()
            if not row:
                raise ValueError('Unknown or deleted media ID')
            return {**json.loads(row[0]), 'id': item, 'url': '/media/' + item}

    def listing(self):
        with self.lock:
            pins = self.references()
            return {'assets': [{**self.asset(r[0]), 'pinned': r[0] in pins} for r in self.db.execute('select id from assets order by created')],
                    'jobs': [dict(zip(('id','source','kind','status','error','created'), r)) for r in self.db.execute('select * from jobs order by created desc limit 50')]}

    def delete(self, item):
        with self.lock:
            self.asset(item)
            if item in self.references():
                raise Conflict('Asset is pinned by active/suspended/selected playback')
            # Delete DB first: a crash leaves an orphan cleaned at startup, never a stale published file.
            self.db.execute('delete from assets where id=?', (item,))
            self.db.commit()
            shutil.rmtree(self.assets / item, ignore_errors=True)

    def cleanup(self, reserve=0):
        with self.lock:
            rows = list(self.db.execute('select id,created from assets order by created'))
            for item, created in rows:
                if item not in self.references() and (created < time.time()-self.ttl or self.disk_bytes()+reserve > self.max_bytes):
                    self.delete(item)
            return self.disk_bytes()

    def disk_bytes(self):
        return sum(p.stat().st_size for base in (self.assets, self.work) for p in base.rglob('*') if p.is_file())

    def submit(self, source, kind):
        source = validate_source(source)
        if kind not in ('master','request'):
            raise ValueError('kind must be master or request')
        with self.lock:
            if self.db.execute("select count(*) from jobs where status in ('queued','preparing')").fetchone()[0] >= 4:
                raise Conflict('Preparation backlog full (one worker, four admitted jobs)')
            item = str(uuid.uuid4())
            self.db.execute('insert into jobs(id,source,kind,status,error,created,retryable) values(?,?,?,?,?,?,?)', (item,source,kind,'queued',None,time.time(),None))
            self.db.execute("delete from jobs where status not in ('queued','preparing') and id not in (select id from jobs order by created desc limit 50)")
            self.db.commit()
            return {'id': item, 'status': 'queued'}

    def worker(self):
        while not self.stop.wait(.1):
            self.cleanup()
            with self.lock:
                row = self.db.execute("select id,source,kind from jobs where status='queued' order by created limit 1").fetchone()
                if not row:
                    continue
                item, source, kind = row
                self.db.execute("update jobs set status='preparing' where id=?", (item,))
                self.db.commit()
            directory = self.work / item
            directory.mkdir()
            try:
                if self.cleanup(reserve=MAX_ASSET_BYTES) + MAX_ASSET_BYTES > self.max_bytes:
                    raise ValueError('Cache full with pinned assets; no preparation started')
                self.run_job([sys.executable, '-m', 'jukebox.prepare', source, kind, str(directory)], directory)
                receipt = json.loads((directory / 'receipt.json').read_text())
                if receipt['bytes'] > MAX_ASSET_BYTES:
                    raise ValueError('Asset byte limit exceeded')
                # Keep only playable bytes and safe audit receipt; no raw logs or upstream URLs.
                for p in directory.iterdir():
                    if p.name not in (receipt['file'], 'receipt.json'):
                        p.unlink()
                with self.lock:
                    directory.rename(self.assets / item)
                    self.db.execute('insert into assets values(?,?,?)', (item,json.dumps(receipt),time.time()))
                    self.db.execute("update jobs set status='ready',error=null,retryable=null where id=?", (item,))
                    self.db.commit()
            except Exception as exc:
                with self.lock:
                    message = str(exc)[:1600]
                    # Permanent source/policy/probe errors are nonretryable; operational and extractor errors remain retryable.
                    permanent = any(term in message.lower() for term in ('duration', 'six minutes', 'audio-only', 'combined/video', 'asset rejected', 'exactly one audio', 'unsupported source', 'invalid youtube', 'only canonical', 'kind must', 'completed individual', 'live recording'))
                    self.db.execute("update jobs set status='failed',error=?,retryable=? where id=?", (message,0 if permanent else 1,item))
                    self.db.commit()
            finally:
                shutil.rmtree(directory, ignore_errors=True)

    def run_job(self, args, directory):
        log = directory / 'process.log'
        with log.open('wb') as out:
            proc = subprocess.Popen(args, stdout=out, stderr=out, start_new_session=True)
            deadline = time.monotonic() + self.job_seconds
            try:
                while proc.poll() is None:
                    size = sum(p.stat().st_size for p in directory.rglob('*') if p.is_file())
                    if self.stop.is_set() or time.monotonic() >= deadline:
                        raise ValueError('Preparation stopped or timed out (bounded job deadline)')
                    if size > MAX_ASSET_BYTES or log.stat().st_size > 1024*1024:
                        raise ValueError('Preparation byte/log limit exceeded')
                    time.sleep(.1)
                if proc.returncode:
                    raw = log.read_text(errors='replace')
                    safe = re.sub(r'https?://\S+', '[URL omitted]', raw)
                    raise ValueError('Preparation failed: ' + safe[-1200:])
            finally:
                # Also kill descendants left by extractor/FFmpeg, even if direct child exited.
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                proc.wait()

    def close(self):
        self.stop.set()
        self.thread.join(timeout=25)
        self.db.close()
        self.file_lock.close()
