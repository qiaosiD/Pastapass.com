#!/usr/bin/env python3
"""Parameterized HTTP-direct factorial runner — the 4 cells of connection × mode.

Reuses the mock-arming, clock-sync and fire helpers from approach_fire.py so the only
variables are the two flags:

  --connection cold|warm   cold = open the fire socket inside the fire window (pay the
                           handshake then); warm = pre-open + keep it hot before the drop.
  --mode reactive|proactive  reactive = long-poll the signal, fire on detect; proactive =
                           sync to the server clock and fire at the launch instant.

Writes one per-cell CSV keyed by the factorial ID (e.g. PY-HD-CO-PX.csv) with raw
per-trial release→hit latency, so the site can show every run.

  MOCK_PORT=3999 python3 bots/python/factorial_http.py --connection cold --mode proactive --id PY-HD-CO-PX --trials 30
"""
import argparse
import csv
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import approach_fire as af  # noqa: E402  (arm, clock_offset, _conn, _warm, _fire)

RESULTS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "benchmark", "results", "factorial")
APPROACH = "http-direct"


def run_trial(trial_i, connection, mode, offset):
    ctrl = af._conn()
    fire = af._warm() if connection == "warm" else None   # warm: hot socket; cold: open at fire time
    data = None
    try:
        if mode == "reactive":
            detect = af._conn()
            af.arm(ctrl, APPROACH, trial_i)
            detect.request("GET", "/status/longpoll")
            detect.getresponse().read()                   # blocks until the server releases
            if connection == "cold":
                fire = af._conn()                         # COLD: handshake lands inside the window
            data = af._fire(fire, APPROACH, trial_i)
            try: detect.close()
            except Exception: pass
        else:  # proactive
            launch_ms = af.arm(ctrl, APPROACH, trial_i).get("launch")
            if launch_ms is None:
                return None
            local_launch = launch_ms / 1000.0 - offset    # launch on our clock
            while True:
                dt = local_launch - time.time()
                if dt <= 0:
                    break
                if dt > 0.003:
                    time.sleep(dt - 0.003)                # coarse sleep, then spin
            if connection == "cold":
                fire = af._conn()                         # COLD: open at the launch instant
            t0 = time.time()
            data = {}
            while not data.get("ok"):                     # fire AT launch; retry if server flips late
                data = af._fire(fire, APPROACH, trial_i)
                if data.get("ok"):
                    break
                if time.time() - t0 > 0.15:
                    data = None
                    break
                time.sleep(0.0003)
    finally:
        for c in (fire, ctrl):
            try:
                if c: c.close()
            except Exception:
                pass
    return int(data["latency_ns"]) if data and data.get("ok") else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--connection", choices=["cold", "warm"], required=True)
    ap.add_argument("--mode", choices=["reactive", "proactive"], required=True)
    ap.add_argument("--id", required=True, help="factorial cell id, e.g. PY-HD-CO-PX")
    ap.add_argument("--trials", type=int, default=30)
    ap.add_argument("--lang", default="python")
    args = ap.parse_args()

    os.makedirs(RESULTS_DIR, exist_ok=True)
    offset = af.clock_offset() if args.mode == "proactive" else 0.0
    rows = []
    for i in range(args.trials):
        lat = run_trial(i, args.connection, args.mode, offset)
        if lat is not None:
            rows.append({"id": args.id, "lang": args.lang, "transport": APPROACH,
                         "connection": args.connection, "mode": args.mode,
                         "trial": i, "server_latency_ns": lat})
        time.sleep(0.03)

    out = os.path.join(RESULTS_DIR, f"{args.id}.csv")
    with open(out, "w", newline="") as fp:
        w = csv.DictWriter(fp, fieldnames=["id", "lang", "transport", "connection", "mode", "trial", "server_latency_ns"])
        w.writeheader()
        w.writerows(rows)

    xs = sorted(r["server_latency_ns"] / 1e6 for r in rows)
    if xs:
        pf = lambda q: xs[min(len(xs) - 1, int(q * len(xs)))]
        print(f"{args.id}  n={len(xs)}  min {xs[0]:.3f}  median {statistics.median(xs):.3f}  p95 {pf(0.95):.3f}  mean {statistics.mean(xs):.3f}")
    print(f"  wrote {out}")


if __name__ == "__main__":
    main()
