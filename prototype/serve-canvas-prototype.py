#!/usr/bin/env python3
"""见岔完整画布原型：固定本机地址，让浏览器可以恢复已保存的研究。"""
import errno
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sys
from urllib.error import URLError
from urllib.request import urlopen
import webbrowser

page = sys.argv[1] if len(sys.argv) > 1 else 'forkwise-step-prototype.html'
root = Path(__file__).resolve().parent
if not (root / page).exists():
    raise SystemExit(f'页面不存在：{page}')
if not (root / 'canvas-built/index.html').exists():
    raise SystemExit('画布尚未构建：进入 prototype/canvas-lab 后运行 npm install 和 npm run build。')

try:
    port = int(os.environ.get('FORKWISE_PROTOTYPE_PORT', '47865'))
    if not 1 <= port <= 65535:
        raise ValueError
except ValueError:
    raise SystemExit('FORKWISE_PROTOTYPE_PORT 必须是 1–65535 之间的端口号。')

origin = f'http://127.0.0.1:{port}'
url = f'{origin}/{page}'
health_path = '/__forkwise_prototype_health'
identity = {'app': 'forkwise-local-prototype', 'root': str(root)}

class LocalHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        if self.path == health_path:
            body = json.dumps(identity).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *args):
        pass

class LocalServer(ThreadingHTTPServer):
    request_queue_size = 256
    daemon_threads = True

try:
    server = LocalServer(('127.0.0.1', port), partial(LocalHandler, directory=str(root)))
except OSError as error:
    if error.errno != errno.EADDRINUSE:
        raise SystemExit(f'本机服务未能启动：{error}')
    try:
        with urlopen(f'{origin}{health_path}', timeout=2) as response:
            existing = json.loads(response.read(4096))
    except (OSError, URLError, ValueError):
        existing = None
    if existing != identity:
        raise SystemExit(
            f'端口 {port} 正被其它服务占用。请关闭占用该端口的服务后重试，'
            '或通过 FORKWISE_PROTOTYPE_PORT 指定固定端口。\n'
            '更换端口会使用另一份浏览器本地存储；原地址的数据不会被删除。'
        )
    print(f'已复用正在运行的见岔画布原型：{url}', flush=True)
    webbrowser.open(url)
    raise SystemExit(0)

print(f'见岔画布原型已启动：{url}', flush=True)
print('再次启动会使用同一地址；请在同一浏览器中打开，以恢复本地研究。', flush=True)
print('关闭这个终端或按 Ctrl+C 可停止本机服务，浏览器本地保存仍保留。', flush=True)
webbrowser.open(url)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
finally:
    server.server_close()
