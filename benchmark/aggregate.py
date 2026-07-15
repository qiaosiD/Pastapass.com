#!/usr/bin/env python3
"""
Aggregate every benchmark/results/*.csv into one comparison table, sorted fastest first
by median release->hit latency.

Run:  python3 benchmark/aggregate.py
"""
import csv
import glob
import os
import statistics

RESULTS_DIR = os.path.join(os.path.dirname(__file__), "results")


def pctile(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))]


def main():
    files = sorted(glob.glob(os.path.join(RESULTS_DIR, "*.csv")))
    if not files:
        print("No results yet. Run a bot first (see README).")
        return

    table = []
    for fp in files:
        with open(fp) as f:
            rows = list(csv.DictReader(f))
        ms = [int(r["server_latency_ns"]) / 1e6 for r in rows if r.get("server_latency_ns")]
        if not ms:
            continue
        label = rows[0]["approach"] + " [" + rows[0].get("lang", "?") + "]"
        table.append({
            "label": label, "n": len(ms),
            "min": min(ms), "median": statistics.median(ms),
            "p95": pctile(ms, 0.95), "max": max(ms), "mean": statistics.mean(ms),
        })

    table.sort(key=lambda r: r["median"])

    print("\n  Server-measured release -> hit latency (milliseconds), fastest first")
    print("  " + "-" * 78)
    print(f"  {'approach [lang]':<30} {'n':>3}  {'min':>7} {'median':>7} {'p95':>7} {'max':>7} {'mean':>7}")
    print("  " + "-" * 78)
    for r in table:
        print(f"  {r['label']:<30} {r['n']:>3}  {r['min']:>7.3f} {r['median']:>7.3f} "
              f"{r['p95']:>7.3f} {r['max']:>7.3f} {r['mean']:>7.3f}")
    print("  " + "-" * 78)
    print("  NOTE: on loopback this isolates code/strategy overhead. Real network RTT")
    print("        (tens of ms) dominates on a deployed target — see README.\n")


if __name__ == "__main__":
    main()
