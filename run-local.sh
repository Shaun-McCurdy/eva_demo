#!/usr/bin/env bash
# Convenience script: loads .env, starts the API, starts Vite, cleans up on exit.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "No .env found. Copy .env.example to .env first."; exit 1; }
set -a; source .env; set +a

if [ -z "${GOOGLE_CLOUD_PROJECT:-}" ]; then
  echo "GOOGLE_CLOUD_PROJECT is not set in .env"; exit 1
fi

[ -d .venv ] || python3 -m venv .venv
source .venv/bin/activate
pip install -q -r server/requirements.txt

( cd server && python main.py ) &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT

[ -d web/node_modules ] || ( cd web && npm install )
cd web && npm run dev
