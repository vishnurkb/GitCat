#!/usr/bin/env bash
# GitCat launcher (macOS/Linux/Git Bash). Terminal app: no ports, no browser.
# Usage: ./start_project.sh [repo-folder]   (default: current folder)
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"

for b in node git; do
  command -v "$b" >/dev/null 2>&1 || { echo " [ERROR] '$b' not found on PATH. Install it and retry."; exit 1; }
  echo " [ok] found $b"
done
command -v gh >/dev/null 2>&1 && echo " [ok] found gh" || echo " [warn] gh not found - GitHub features will not work."
command -v ollama >/dev/null 2>&1 && echo " [ok] found ollama" || echo " [warn] ollama not found - Groq only (needs GROQ_API_KEY in .env)."
[ -f "$ROOT/.env" ] || echo " [warn] no .env - copy .env.example to .env and add GROQ_API_KEY for the cloud fallback."

if [ ! -d "$ROOT/node_modules" ]; then
  echo " Installing dependencies (first run only)..."
  (cd "$ROOT" && npm install) || { echo " [ERROR] npm install failed."; exit 1; }
fi

TARGET="${1:-$PWD}"
[ -d "$TARGET" ] || { echo " [ERROR] folder not found: $TARGET"; exit 1; }
echo " Starting GitCat in $TARGET"
exec node "$ROOT/bin/gitcat.js" --cwd "$TARGET"
