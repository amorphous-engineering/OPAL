#!/usr/bin/env bash
# Run an isolated OPAL dev stack: FastAPI (API) + Vite (web client).
#   scripts/dev.sh [N]   N = instance slot (default 0) → API :8000+N, web :5173+N
# Each slot gets its own seeded SQLite database under <repo>/notes/dev-data/slotN.
# Reset a slot's data: rm -rf notes/dev-data/slotN
set -euo pipefail
N="${1:-0}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="$ROOT/notes/dev-data/slot$N"
API_PORT=$((8000 + N))
WEB_PORT=$((5173 + N))
export OPAL_UPLOAD_DIR="$DATA/attachments"
mkdir -p "$DATA"
cd "$ROOT"
if [ ! -f "$DATA/opal.db" ]; then
	uv run opal init --database "$DATA/opal.db" >/dev/null
	uv run opal seed --database "$DATA/opal.db" >/dev/null
	echo "seeded $DATA/opal.db (users build/test/qa, password kestrel-demo)"
fi
uv run opal serve --host 127.0.0.1 --port "$API_PORT" --database "$DATA/opal.db" >"$DATA/api.log" 2>&1 &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT
cd "$ROOT/frontend"
echo "API http://127.0.0.1:$API_PORT  web http://127.0.0.1:$WEB_PORT  (api log: $DATA/api.log)"
OPAL_API_PORT=$API_PORT OPAL_WEB_PORT=$WEB_PORT pnpm exec vite dev --host 127.0.0.1
