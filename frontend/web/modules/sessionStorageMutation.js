import { spawn } from "node:child_process";
import { delimiter, join } from "node:path";

const mutationScript = `
import json, sys
from myharness.services.session_storage import update_session_metadata, rewrite_session_snapshot_if_unchanged, delete_session_by_id, migrate_session_snapshots, move_session_snapshot
request = json.load(sys.stdin)
try:
    operation = request['operation']
    if operation == 'metadata':
        result = update_session_metadata(request['cwd'], request['sessionId'], request['patch'])
    elif operation == 'rewrite':
        result = rewrite_session_snapshot_if_unchanged(request['cwd'], request['fileName'], request['payload'], request.get('expected'))
    elif operation == 'delete':
        result = delete_session_by_id(request['cwd'], request['sessionId'])
    elif operation == 'migrate':
        result = migrate_session_snapshots(request['cwd'])
    elif operation == 'move':
        result = move_session_snapshot(request['cwd'], request['targetCwd'], request['sessionId'])
    else:
        raise ValueError('Unknown session mutation')
    print(json.dumps({'result': result}, ensure_ascii=False))
except Exception as error:
    print(json.dumps({'error': str(error)}, ensure_ascii=False))
    sys.exit(1)
`;

// Both web metadata edits and backend autosaves acquire the Python OS lock.
export function mutateSessionStorage(python, repoRoot, request, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python.file, [...(python.args || []), "-c", mutationScript], {
      cwd: repoRoot, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONPATH: [join(repoRoot, "src"), process.env.PYTHONPATH].filter(Boolean).join(delimiter), PYTHONIOENCODING: "utf-8" },
    });
    let output = "";
    let diagnostic = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Session save timed out")); }, timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { diagnostic = `${diagnostic}${chunk}`.slice(-2000); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdin.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (code !== 0 || result.error) reject(new Error(result.error || diagnostic || "Could not save session"));
        else resolve(result.result);
      } catch { reject(new Error(diagnostic || "Could not save session")); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
