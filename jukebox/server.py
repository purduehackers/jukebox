"""Loopback-only local proof HTTP API and range-capable media delivery."""
import argparse
import json
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from .store import Store, Conflict

WEB = Path(__file__).resolve().parent.parent / 'web'


def byte_range(header, size):
    if header is None:
        return 0, size-1, False
    match = re.fullmatch(r'bytes=(\d*)-(\d*)', header)
    if not match or not any(match.groups()):
        raise ValueError('Unsupported or malformed range')
    a, b = match.groups()
    if not a:
        length = int(b)
        if length <= 0:
            raise ValueError('Empty suffix')
        start, end = max(0, size-length), size-1
    else:
        start, end = int(a), min(int(b),size-1) if b else size-1
    if start >= size or start > end:
        raise ValueError('Unsatisfiable range')
    return start, end, True


def make_server(store, port=8971):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def handle(self):
            try:
                super().handle()
            except (BrokenPipeError, ConnectionResetError):
                pass  # media loads/seeks commonly close keep-alive connections

        def log_message(self, *_):
            pass  # do not log submitted/source URLs or device tokens

        def reply(self, status, value, mime='application/json'):
            data = json.dumps(value).encode() if mime == 'application/json' else value
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'")
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(data)

        def guard(self):
            allowed = {f'localhost:{self.server.server_port}', f'127.0.0.1:{self.server.server_port}'}
            if self.headers.get('Host') not in allowed:
                raise ValueError('Loopback Host required')
            origin = self.headers.get('Origin')
            if origin and origin not in {'http://' + host for host in allowed}:
                raise ValueError('Same-origin local proof requests only')

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            try:
                self.guard()
                path = urlsplit(self.path).path
                if path == '/api/status':
                    self.reply(200, {**store.listing(), 'player': store.player(),
                                     'limits': {'cacheBytes': store.max_bytes, 'jobSeconds': store.job_seconds,
                                                'assetBytes': 256*1024*1024, 'admittedJobs': 4}})
                elif re.fullmatch(r'/media/[a-f0-9-]{36}', path):
                    self.media(path.split('/')[-1])
                elif path in ('/', '/display', '/app.js', '/turn.js', '/style.css'):
                    file = 'index.html' if path in ('/', '/display') else path[1:]
                    mime = 'text/html; charset=utf-8' if file.endswith('html') else ('text/css' if file.endswith('css') else 'text/javascript')
                    self.reply(200, (WEB / file).read_bytes(), mime)
                else:
                    self.reply(404, {'error': 'Not found'})
            except (ValueError, FileNotFoundError) as exc:
                self.reply(404, {'error': str(exc)})
            except (BrokenPipeError, ConnectionResetError):
                pass

        def media(self, item):
            # Hold cache lock through open: deletion cannot race lookup/open.
            with store.lock:
                asset = store.asset(item)
                f = (store.assets / item / asset['file']).open('rb')
            with f:
                size = asset['bytes']
                etag = '"' + item + '"'
                header = self.headers.get('Range')
                if self.headers.get('If-Range') not in (None,etag):
                    header = None
                try:
                    start, end, partial = byte_range(header, size)
                except ValueError:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                self.send_response(206 if partial else 200)
                self.send_header('Content-Type', asset['mime'])
                self.send_header('Accept-Ranges', 'bytes')
                self.send_header('ETag', etag)
                self.send_header('Cache-Control', 'private, max-age=0, must-revalidate')
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.send_header('Content-Length', str(end-start+1))
                if partial:
                    self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                self.end_headers()
                if self.command == 'HEAD':
                    return
                f.seek(start)
                remaining = end-start+1
                while remaining:
                    block = f.read(min(65536, remaining))
                    if not block:
                        break
                    self.wfile.write(block)
                    remaining -= len(block)

        def do_POST(self):
            try:
                self.guard()
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= 16384 or self.headers.get('Content-Type') != 'application/json':
                    raise ValueError('Small JSON body required')
                body = json.loads(self.rfile.read(length))
                path = urlsplit(self.path).path
                if path == '/api/prepare':
                    self.reply(202, store.submit(body.get('source'), body.get('kind')))
                elif path == '/api/claim':
                    self.reply(200, store.claim(body.get('token')))
                elif path == '/api/checkpoint':
                    self.reply(200, store.checkpoint(body.get('token'), body.get('revision'), body.get('state')))
                elif path == '/api/release':
                    store.release(body.get('token'))
                    self.reply(200, {'released': True})
                elif path == '/api/delete':
                    store.delete(body.get('id'))
                    self.reply(200, {'deleted': True})
                elif path == '/api/cleanup':
                    self.reply(200, {'bytes': store.cleanup()})
                else:
                    self.reply(404, {'error': 'Not found'})
            except Conflict as exc:
                self.reply(409, {'error': str(exc)})
            except (ValueError, TypeError, KeyError) as exc:
                self.reply(400, {'error': str(exc)})
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8971)
    parser.add_argument('--data', default='.local/jukebox')
    parser.add_argument('--job-seconds', type=float, default=240)
    args = parser.parse_args()
    store = Store(args.data, job_seconds=args.job_seconds)
    try:
        server = make_server(store, args.port)
    except BaseException:
        store.close()
        raise
    print(f'Phase-1 proof: http://127.0.0.1:{server.server_port}/display', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        store.close()


if __name__ == '__main__':
    main()
