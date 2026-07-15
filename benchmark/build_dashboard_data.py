#!/usr/bin/env python3
"""
Build the dashboard's data file from benchmark/results/*.csv.

Writes web/results.json, which the Vercel-hosted dashboard reads statically. Each
invocation LOGS the current run — it appends a timestamped entry to a `runs` history
so the site shows every A/B test you've run over time, not just the latest.

Workflow (fits the git-gated flow — you own the commit/push):
    ./run-all.sh                                  # produces benchmark/results/*.csv
    python3 benchmark/build_dashboard_data.py --label "loopback sweep"
    git add web/results.json && git commit && git push   # Vercel auto-redeploys

Run with no CSVs present and it leaves the existing results.json untouched.
"""
import argparse
import csv
import glob
import json
import os
import statistics
import time

HERE = os.path.dirname(__file__)
RESULTS_DIR = os.path.join(HERE, "results")
OUT = os.path.join(HERE, "..", "web", "results.json")


def pctile(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))]


def aggregate():
    """Return (groups sorted fastest-first, total_measurements)."""
    groups, total = [], 0
    for fp in sorted(glob.glob(os.path.join(RESULTS_DIR, "*.csv"))):
        with open(fp) as f:
            rows = list(csv.DictReader(f))
        ms = [int(r["server_latency_ns"]) / 1e6 for r in rows if r.get("server_latency_ns")]
        if not ms:
            continue
        total += len(ms)
        groups.append({
            "approach": rows[0]["approach"],
            "lang": rows[0].get("lang", "?"),
            "n": len(ms),
            "min_ms": round(min(ms), 4),
            "p50_ms": round(statistics.median(ms), 4),
            "p95_ms": round(pctile(ms, 0.95), 4),
            "max_ms": round(max(ms), 4),
            "mean_ms": round(statistics.mean(ms), 4),
        })
    groups.sort(key=lambda g: g["p50_ms"])
    return groups, total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="", help="optional label for this run, e.g. 'loopback sweep'")
    ap.add_argument("--iso", default=None, help="ISO timestamp for this run (default: now)")
    args = ap.parse_args()

    groups, total = aggregate()
    if not groups:
        print("No CSVs in benchmark/results/ — nothing to log. Run ./run-all.sh first.")
        return

    # Load prior runs so this is a growing LOG, not an overwrite.
    prior = {}
    if os.path.exists(OUT):
        try:
            with open(OUT) as f:
                prior = json.load(f)
        except Exception:
            prior = {}
    runs = prior.get("runs", [])

    now_iso = args.iso or time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())
    fastest = groups[0]
    runs.append({
        "at": now_iso,
        "label": args.label,
        "measurements": total,
        "fastest": {"approach": fastest["approach"], "lang": fastest["lang"], "p50_ms": fastest["p50_ms"]},
        "groups": groups,
    })

    out = {
        "updated_at": now_iso,
        "total_runs": len(runs),
        "total_measurements": total,
        "groups": groups,          # latest run — what the chart/table show
        "runs": runs,              # full history — the A/B-test log
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=2)

    print(f"Logged run #{len(runs)}"
          + (f' "{args.label}"' if args.label else "")
          + f": {total} measurements, fastest {fastest['approach']} [{fastest['lang']}] "
          f"{fastest['p50_ms']:.3f} ms  →  {os.path.relpath(OUT)}")


if __name__ == "__main__":
    main()
