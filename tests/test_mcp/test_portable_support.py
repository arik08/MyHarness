"""Copied package and Node network tests without a compatible host shim."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

ROOT = Path(__file__).resolve().parents[2]


def test_generated_support_matches_canonical_sources():
    spec = importlib.util.spec_from_file_location("sync_support", ROOT / "scripts/sync_mcp_support.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.sync(check=True) == []


@pytest.mark.parametrize("name", sorted(
    path.parent.parent.name for path in (ROOT / ".skills/mcp").glob("*/runtime/server.py")
    if not path.parent.parent.name.startswith("posco-")
))
def test_copied_package_does_not_use_host_helper_signatures(tmp_path, name):
    target = tmp_path / name
    shutil.copytree(ROOT / ".skills/mcp" / name, target, ignore=shutil.ignore_patterns("__pycache__", "node_modules"))
    prepared = subprocess.run(
        [sys.executable, "-I", str(target / "runtime/prepare.py"), "--check"],
        cwd=tmp_path, text=True, capture_output=True, timeout=20,
    )
    assert prepared.returncode == 0, prepared.stderr
    # The other application may provide an older, incompatible myharness shim.
    # Refuse all imports from it to prove this is a standalone package.
    script = '''
import importlib.abc, sys, runpy, json
class RejectHost(importlib.abc.MetaPathFinder):
 def find_spec(self, fullname, path=None, target=None):
  if fullname == 'myharness' or fullname.startswith('myharness.'):
   raise ModuleNotFoundError('host shim intentionally unavailable')
sys.meta_path.insert(0, RejectHost())
server = runpy.run_path(sys.argv[1])
from _myharness_mcp_support import official_data as h
assert json.loads(h.result_envelope(source='fixture',source_id='id',data=[1],unit='USD'))['unit']=='USD'
assert json.loads(h.checked_health_envelope(source='fixture',probe=lambda:True,success_detail='ok',require_all_credentials=True))['ok']
import httpx
h.request=lambda *a,**k: httpx.Response(200,content=b'{"name":"\\x96"}')
assert h.request_json('fixture','https://example.test',fallback_encoding='cp1252')['name']=='–'
print('portable contract PASS')
'''
    result = subprocess.run([sys.executable, "-I", "-c", script, str(target / "runtime/server.py")], text=True, capture_output=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert "PASS" in result.stdout


def _node_environment():
    env = {k:v for k,v in os.environ.items() if not any(token in k.upper() for token in ("PROXY", "SSL_CERT", "REQUESTS_CA", "NODE_EXTRA_CA"))}
    env["MYHARNESS_MCP_PYTHON"] = sys.executable
    return env


def _node_fetch(url, env, script=None):
    preload = ROOT / ".skills/mcp/national-assembly/runtime/_myharness_mcp_support/node_fetch.cjs"
    command = script or "fetch(process.argv[1]).then(async r=>console.log(JSON.stringify({status:r.status,body:await r.text()}))).catch(e=>{console.error(e.message);process.exitCode=1})"
    return subprocess.run(["node", "--require", str(preload), "-e", command, url], env=env, text=True, capture_output=True, timeout=15)


def test_node_fetch_obeys_proxy_and_retains_http_error_status():
    paths = []
    class Proxy(BaseHTTPRequestHandler):
        def do_GET(self):
            paths.append(self.path)
            self.send_response(429 if 'rate-limit' in self.path else 200)
            self.send_header('Retry-After', '7')
            self.end_headers()
            self.wfile.write(b'{"via":"proxy"}')
        def log_message(self, *args): pass
    server = ThreadingHTTPServer(('127.0.0.1',0), Proxy)
    thread = threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        env = _node_environment();env['HTTP_PROXY']=f'http://127.0.0.1:{server.server_port}';env['NO_PROXY']=''
        for path, status in [('ok',200),('rate-limit',429)]:
            result = _node_fetch(f'http://unresolvable-mcp.invalid/{path}',env)
            assert result.returncode == 0, result.stderr
            assert json.loads(result.stdout)['status']==status
        assert len(paths)==2
    finally:
        server.shutdown();server.server_close();thread.join()


def test_node_fetch_trusts_configured_ca_but_never_disables_tls_verification(tmp_path):
    import ssl
    cert=tmp_path/'cert.pem';key=tmp_path/'key.pem'
    subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost'],check=True,capture_output=True)
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self): self.send_response(200);self.end_headers();self.wfile.write(b'trusted')
        def log_message(self,*args): pass
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(cert,key)
    server.socket=context.wrap_socket(server.socket,server_side=True)
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        url=f'https://localhost:{server.server_port}/?key=never-print-this-secret'
        env=_node_environment()
        denied=_node_fetch(url,env)
        assert denied.returncode==1
        assert 'never-print-this-secret' not in denied.stderr
        env['SSL_CERT_FILE']=str(cert)
        result=_node_fetch(url,env)
        assert result.returncode==0,result.stderr
        assert json.loads(result.stdout)['body']=='trusted'
    finally:
        server.shutdown();server.server_close();thread.join()
