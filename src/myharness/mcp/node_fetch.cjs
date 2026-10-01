// Read-only fetch transport shared by the two packaged Node MCPs.
const { spawn } = require('node:child_process');
const path = require('node:path');
const python = process.env.MYHARNESS_MCP_PYTHON;
if (!python) throw new Error('MYHARNESS_MCP_PYTHON is required for packaged MCP transport');
globalThis.fetch = async function (input, init = {}) {
  const request = new Request(input, init);
  const timeout = Number(process.env.MCP_HTTP_TIMEOUT_MS || 30000);
  if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 120000) throw new Error('MCP_HTTP_TIMEOUT_MS must be 1000..120000');
  if (!['GET', 'HEAD'].includes(request.method)) throw new Error('Packaged public-data MCP transport supports GET/HEAD only');
  if (request.signal.aborted) throw new DOMException('Request aborted', 'AbortError');
  const raw = await new Promise((resolve, reject) => {
    const child = spawn(python, [path.join(__dirname, 'node_http_bridge.py')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let output = '', size = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); request.signal.removeEventListener('abort', abort);
      if (error) { child.kill(); reject(error); } else resolve(value);
    };
    const abort = () => finish(new DOMException('Request aborted', 'AbortError'));
    const timer = setTimeout(abort, timeout + 1000);
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    child.on('error', () => finish(new Error('MCP Python transport could not start')));
    child.stdin.on('error', () => finish(new Error('MCP Python transport input failed')));
    child.stderr.resume(); // never forward third-party URLs or headers into logs
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { size += Buffer.byteLength(chunk); if (size > 30 * 1024 * 1024) finish(new Error('MCP response too large')); else output += chunk; });
    child.on('close', code => {
      if (code !== 0) return finish(new Error('MCP Python transport failed'));
      try { const data = JSON.parse(output); if (data.error) finish(new Error(data.error)); else finish(null, data); }
      catch { finish(new Error('MCP Python transport returned invalid JSON')); }
    });
    child.stdin.end(JSON.stringify({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), timeout_ms: timeout }));
  });
  return new Response([204, 205, 304].includes(raw.status) || request.method === 'HEAD' ? null : Buffer.from(raw.body, 'base64'), { status: raw.status, headers: raw.headers });
};
