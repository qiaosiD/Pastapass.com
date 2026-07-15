#!/usr/bin/env bash
# One-command benchmark: start the mock server, run every available bot against it,
# print the comparison table, then shut the server down.
#
#   ./run-all.sh            # default trials
#   TRIALS=50 ./run-all.sh  # more trials for tighter percentiles
set -euo pipefail
cd "$(dirname "$0")"

TRIALS="${TRIALS:-30}"
BROWSER_TRIALS="${BROWSER_TRIALS:-10}"
PORT="${PORT:-3000}"
export MOCK_PORT="$PORT"

echo "==> starting mock server on :$PORT"
PORT="$PORT" node mock-site/server.js &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

# wait for health
for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
echo "==> server up"

rm -f benchmark/results/*.csv 2>/dev/null || true

echo "==> Approach B: Python HTTP-direct"
python3 bots/python/approach_b_http.py --trials "$TRIALS" --lang python || true

echo "==> Approach B: Node HTTP-direct"
node bots/node/approach_b_http.mjs --trials "$TRIALS" --lang node || true

if command -v go >/dev/null 2>&1; then
  echo "==> Approach B: Go HTTP-direct"
  go run bots/go/approach_b_http.go --trials "$TRIALS" --lang go || true
else
  echo "==> (skip) Go not installed — https://go.dev/dl/ to enable the compiled tier"
fi

if python3 -c 'import playwright' 2>/dev/null; then
  echo "==> Approach A: Python browser + MutationObserver"
  python3 bots/python/approach_a_browser.py --trials "$BROWSER_TRIALS" || true
  echo "==> Approach C: Python hybrid (browser + injected fetch)"
  python3 bots/python/approach_c_hybrid.py --trials "$BROWSER_TRIALS" || true
else
  echo "==> (skip) Playwright not installed — pip install playwright && python3 -m playwright install chromium"
fi

echo
echo "==> RESULTS"
python3 benchmark/aggregate.py
