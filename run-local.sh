#!/usr/bin/env bash
# Convenience script: loads .env, starts the API, starts Vite, cleans up on exit.
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "No .env found. Copy .env.example to .env first."; exit 1; }
set -a; source .env; set +a

# The API key is what every live session needs. The project is only Firestore's
# concern, so warn rather than refuse to start.
if [ -z "${GEMINI_API_KEY:-}" ]; then
  echo "GEMINI_API_KEY is not set in .env -- get one at https://aistudio.google.com/apikey"; exit 1
fi

if [ "${STORE_BACKEND:-file}" = "firestore" ] && [ -z "${GOOGLE_CLOUD_PROJECT:-}" ]; then
  echo "warning: STORE_BACKEND=firestore but GOOGLE_CLOUD_PROJECT is unset; the studio will not be able to save variants"
fi

[ -d .venv ] || python3 -m venv .venv
source .venv/bin/activate
pip install -q -r server/requirements.txt

( cd server && python main.py ) &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT

[ -d web/node_modules ] || ( cd web && npm install )
cd web && npm run dev
