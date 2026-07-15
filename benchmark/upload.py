#!/usr/bin/env python3
"""
Push local benchmark results into the PastaPass Cloudflare backend.

Reads every benchmark/results/*.csv (the files the bots write) and POSTs the rows to
/api/ingest on your deployed Pages project. Read-only dashboard, private write path:
the endpoint requires the bearer token you set with `wrangler pages secret put INGEST_TOKEN`.

Config via environment:
  PASTAPASS_URL     base URL of the deployed site   (e.g. https://pastapass.com)
  PASTAPASS_TOKEN   the same value as the INGEST_TOKEN secret

Run:
  PASTAPASS_URL=https://pastapass.com PASTAPASS_TOKEN=... python3 benchmark/upload.py
  python3 benchmark/upload.py --dry-run        # parse + preview, send nothing

Uses only the Python standard library.
"""
import argparse
import csv
import glob
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

RESULTS_DIR = os.path.join(os.path.dirname(__file__), "results")
FIELDS = ("approach", "lang", "trial", "server_latency_ns", "client_fire_ns")


def load_rows():
    """Every row from every results CSV, coerced to the ingest shape."""
    rows = []
    for fp in sorted(glob.glob(os.path.join(RESULTS_DIR, "*.csv"))):
        with open(fp, newline="") as f:
            for r in csv.DictReader(f):
                if not r.get("server_latency_ns"):
                    continue
                rows.append({
                    "approach": (r.get("approach") or "").strip(),
                    "lang": (r.get("lang") or "?").strip() or "?",
                    "trial": int(r["trial"]) if r.get("trial") not in (None, "") else 0,
                    "server_latency_ns": int(r["server_latency_ns"]),
                    "client_fire_ns": int(r["client_fire_ns"]) if r.get("client_fire_ns") else None,
                })
    return rows


def post(url, token, payload):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def summarize(rows):
    by_group = {}
    for r in rows:
        by_group.setdefault((r["approach"], r["lang"]), 0)
        by_group[(r["approach"], r["lang"])] += 1
    for (approach, lang), n in sorted(by_group.items()):
        print(f"    {approach:<18} [{lang:<6}]  {n:>4} rows")


def main():
    ap = argparse.ArgumentParser(description="Upload benchmark CSVs to the PastaPass backend.")
    ap.add_argument("--url", default=os.environ.get("PASTAPASS_URL"))
    ap.add_argument("--token", default=os.environ.get("PASTAPASS_TOKEN"))
    ap.add_argument("--dry-run", action="store_true", help="parse and preview, send nothing")
    args = ap.parse_args()

    rows = load_rows()
    if not rows:
        print(f"No rows found in {RESULTS_DIR}. Run a benchmark first (./run-all.sh).")
        return 1

    run_id = uuid.uuid4().hex
    print(f"Parsed {len(rows)} measurement rows (run_id={run_id}):")
    summarize(rows)

    if args.dry_run:
        print("\n--dry-run: nothing sent.")
        return 0

    if not args.url or not args.token:
        print("\nMissing --url/--token (or PASTAPASS_URL / PASTAPASS_TOKEN). See DEPLOY.md.", file=sys.stderr)
        return 2

    endpoint = args.url.rstrip("/") + "/api/ingest"
    print(f"\nPOST {endpoint}")
    try:
        result = post(endpoint, args.token, {"run_id": run_id, "rows": rows})
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}: {e.read().decode(errors='replace')}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"  connection failed: {e.reason}", file=sys.stderr)
        return 1

    print(f"  {json.dumps(result)}")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
