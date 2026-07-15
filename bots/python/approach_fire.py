#!/usr/bin/env python3
"""
Experiment #3 bot — PROACTIVE (scheduled) vs REACTIVE firing.

Both arms hold a WARM keep-alive connection, so the only variable is the *strategy*:

  reactive   — long-poll the "is it live?" signal; the instant it returns, fire.
  proactive  — read the server's launch time, sync your clock to the server's, and fire
               AT the launch instant (blind), retrying tightly if the server flips a hair
               late. No detection round-trip sits in the path.

Score = server-measured release->hit. Proactive should land closer to the release because
it's pre-positioned; a reactor first pays a detect round-trip. On loopback that round-trip
is tiny, so the gap is small — the proactive edge scales with network RTT.

Run:  python3 bots/python/approach_fire.py --mode proactive --trials 30
"""
import argparse
import csv
import http.client
import json
import os
import statistics
import time
import urllib.request

HOST = os.environ.get("MOCK_HOST", "127.0.0.1")
PORT = int(os.environ.get("MOCK_PORT", "3000"))
BASE = f"http://{HOST}:{PORT}"
RESULTS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "benchmark", "results")


def _conn():
    c = http.client.HTTPConnection(HOST, PORT, timeout=35)
    c.connect()
    return c


def _warm():
    c = _conn()
    c.request("GET", "/health")
    c.getresponse().read()
    return c


def arm(ctrl, approach, trial, base=250, jitter=0):
    body = json.dumps({"approach": approach, "trial": trial, "baseDelayMs": base, "jitterMs": jitter})
    ctrl.request("POST", "/control/arm", body, {"Content-Type": "application/json"})
    return json.loads(ctrl.getresponse().read())        # {ok, state, launch}


def clock_offset(samples=10):
    """NTP/Cristian offset vs the server (loopback: ~0). offset = server_now - local_mid."""
    best = None
    for _ in range(samples):
        t0 = time.time()
        with urllib.request.urlopen(f"{BASE}/api/server-time", timeout=5) as r:
            now = json.loads(r.read())["now"] / 1000.0
        t1 = time.time()
        rtt = t1 - t0
        if best is None or rtt < best[0]:
            best = (rtt, now - (t0 + t1) / 2.0)
        time.sleep(0.01)
    return best[1] if best else 0.0


def _fire(conn, approach, trial):
    conn.request("GET", f"/buy?approach={approach}&trial={trial}")
    return json.loads(conn.getresponse().read())


def trial_reactive(approach, trial):
    f, ctrl, detect = _warm(), _conn(), _conn()
    arm(ctrl, approach, trial)
    detect.request("GET", "/status/longpoll")
    detect.getresponse().read()                          # blocks until release
    data = _fire(f, approach, trial)                     # fire the instant we detect
    for c in (f, ctrl, detect):
        try: c.close()
        except Exception: pass
    return int(data["latency_ns"]) if data.get("ok") else None


def trial_proactive(approach, trial, offset):
    f, ctrl = _warm(), _conn()
    launch_ms = arm(ctrl, approach, trial).get("launch")  # jitter 0 -> a known launch
    if launch_ms is None:
        return None
    local_launch = launch_ms / 1000.0 - offset            # launch on OUR clock

    while True:                                            # coarse-sleep to ~3 ms, then spin
        dt = local_launch - time.time()
        if dt <= 0:
            break
        if dt > 0.003:
            time.sleep(dt - 0.003)

    t0 = time.time()                                      # fire AT launch; retry if server flips late
    data = {}
    while not data.get("ok"):
        data = _fire(f, approach, trial)
        if data.get("ok"):
            break
        if time.time() - t0 > 0.15:
            data = None
            break
        time.sleep(0.0003)
    for c in (f, ctrl):
        try: c.close()
        except Exception: pass
    return int(data["latency_ns"]) if data else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=30)
    ap.add_argument("--approach", default="fire")
    ap.add_argument("--lang", default="python")
    ap.add_argument("--mode", choices=["reactive", "proactive"], required=True)
    args = ap.parse_args()

    os.makedirs(RESULTS_DIR, exist_ok=True)
    offset = clock_offset() if args.mode == "proactive" else 0.0
    rows = []
    for i in range(args.trials):
        lat = (trial_reactive(args.approach, i) if args.mode == "reactive"
               else trial_proactive(args.approach, i, offset))
        if lat is not None:
            rows.append({"approach": args.approach, "lang": args.lang, "trial": i,
                         "server_latency_ns": lat, "client_fire_ns": ""})
        time.sleep(0.03)

    out = os.path.join(RESULTS_DIR, f"{args.approach}_{args.lang}.csv")
    with open(out, "w", newline="") as fp:
        w = csv.DictWriter(fp, fieldnames=["approach", "lang", "trial", "server_latency_ns", "client_fire_ns"])
        w.writeheader(); w.writerows(rows)

    xs = sorted(r["server_latency_ns"] / 1e6 for r in rows)
    if xs:
        p = lambda q: xs[min(len(xs) - 1, int(q * len(xs)))]
        print(f"\n{args.approach} [{args.mode}]  (n={len(xs)})  release->hit, ms")
        print(f"  min {xs[0]:.3f}   median {statistics.median(xs):.3f}   p95 {p(0.95):.3f}   mean {statistics.mean(xs):.3f}")
    print(f"  wrote {out}")


if __name__ == "__main__":
    main()
