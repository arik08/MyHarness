#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# Finder does not inherit the interactive shell's PATH.
export PATH="$PWD/.myharness-venv/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/Documents/Codex/tools/bin:$PATH"
if ! command -v python >/dev/null || ! command -v node >/dev/null; then
  echo "Python (3.10+) and Node.js (20.19+ or 22.12+) are required."
  exit 1
fi
if [ ! -x .myharness-venv/bin/python ]; then
  python -m venv .myharness-venv
fi
export PATH="$PWD/.myharness-venv/bin:$PATH"
if [ ! -d frontend/web/node_modules ]; then
  npm ci --prefix frontend/web
fi
if [ ! -f frontend/web/dist/index.html ]; then
  npm run build --prefix frontend/web
fi
if ! python -c 'import myharness, openai, mcp' >/dev/null 2>&1; then
  python -m pip install -e .
fi
exec python scripts/run_myharness_web.py
