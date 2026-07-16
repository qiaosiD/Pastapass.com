#!/usr/bin/env python3
"""Build web/factorial.json — the measured cells of the 24-config factorial matrix.

Combines the parameterized HTTP-direct runs (benchmark/results/factorial/*.csv) with the
existing single-config arms mapped to their natural cell. Only cells we actually measured
are emitted (with raw per-trial samples); the front end draws the full 24-cell design and
marks the rest "not run".
"""
import csv
import glob
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import stats  # noqa: E402

HERE = os.path.dirname(__file__)
FACT_DIR = os.path.join(HERE, "results", "factorial")
RES_DIR = os.path.join(HERE, "results")
OUT = os.path.join(HERE, "..", "web", "factorial.json")

# Existing single-config arms → the factorial cell they actually represent.
# (browser transports are warm+reactive by nature; the rust bot is HTTP-direct warm+reactive.)
ARM_TO_CELL = {
    "http-direct_rust": "RS-HD-WA-RX",
    "browser-observer_python": "PY-BO-WA-RX",
    "browser-hybrid_python": "PY-HY-WA-RX",
}


def ms_from(fp):
    with open(fp) as f:
        rows = list(csv.DictReader(f))
    return [int(r["server_latency_ns"]) / 1e6 for r in rows if r.get("server_latency_ns")]


def main():
    cells = {}
    for fp in sorted(glob.glob(os.path.join(FACT_DIR, "*.csv"))):
        cid = os.path.splitext(os.path.basename(fp))[0]
        ms = ms_from(fp)
        if ms:
            cells[cid] = ms
    for arm, cid in ARM_TO_CELL.items():
        fp = os.path.join(RES_DIR, f"{arm}.csv")
        if os.path.exists(fp) and cid not in cells:
            ms = ms_from(fp)
            if ms:
                cells[cid] = ms

    out_cells = {}
    for cid, ms in cells.items():
        s = stats.summary(ms)
        out_cells[cid] = {
            "n": len(ms),
            "samples": [round(x, 4) for x in ms],
            "p50": round(s["p50"], 4), "p95": round(s["p95"], 4),
            "mean": round(s["mean"], 4), "min": round(s["min"], 4), "max": round(s["max"], 4),
        }

    out = {
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime()),
        "total_cells": 24,
        "measured": len(out_cells),
        "cells": out_cells,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=2)
    print(f"wrote {os.path.relpath(OUT)}: {len(out_cells)}/24 cells measured")
    for cid in sorted(out_cells):
        c = out_cells[cid]
        print(f"  {cid}  n={c['n']:<3} p50={c['p50']:.3f}  p95={c['p95']:.3f}")


if __name__ == "__main__":
    main()
