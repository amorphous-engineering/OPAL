#!/usr/bin/env bash
# Run an isolated OPAL dev stack on the Mojave Sphinx demo: the Bun API and the Vite web client.
#   scripts/dev.sh [N]   N = instance slot (default 0) → API :8100+N, web :5173+N
# Each slot keeps its own data folder under <repo>/notes/dev-data/slotN, loaded on first run.
# Reset a slot's data: rm -rf notes/dev-data/slotN
set -euo pipefail
N="${1:-0}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="$ROOT/notes/dev-data/slot$N"
API_PORT=$((8100 + N))
WEB_PORT=$((5173 + N))
if [ ! -f "$DATA/opal.db" ]; then
	(cd "$ROOT/server" && bun scripts/load-demo.ts "$DATA")
	echo "loaded Mojave Sphinx into $DATA (users build/test/qa, password sphinx-demo)"
fi
cd "$ROOT/server"
OPAL_DATA_DIR="$DATA" OPAL_HOST=127.0.0.1 OPAL_PORT="$API_PORT" OPAL_PLUGINS=0 \
	bun src/cli.ts serve >"$DATA/api.log" 2>&1 &
API_PID=$!
trap 'kill $API_PID 2>/dev/null' EXIT
cd "$ROOT/frontend"
echo "API http://127.0.0.1:$API_PORT  web http://127.0.0.1:$WEB_PORT  (api log: $DATA/api.log)"
OPAL_API_PORT=$API_PORT pnpm exec vite dev --host 127.0.0.1 --port "$WEB_PORT"
