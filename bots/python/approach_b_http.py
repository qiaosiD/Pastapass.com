#!/usr/bin/env python3
"""
Approach B — Headless HTTP-direct sniper (Python baseline, stdlib only).

Strategy:
  * No browser. Pure sockets.
  * Pre-warm a keep-alive "fire" connection so the TCP/TLS handshake is already paid
    for before the drop — at go-time we only send bytes, we don't open a connection.
  * Long-poll /status/longpoll on a second connection; it returns the instant the
    server releases. The moment it returns, fire GET /buy on the pre-warmed socket.

The authoritative score is the server-measured release->hit latency, returned in the
/buy response. We also record a client-side detect->fired delta as a diagnostic.

Run:  python3 bots/python/approach_b_http.py --trials 30
"""
import argparse
import csv
import http.client
import json
import os
import statistics
import time

HOST = os.environ.get("MOCK_HOST", "127.0.0.1")
PORT = int(os.environ.get("MOCK_PORT", "3000"))
RESULTS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "benchmark", "results")


def _conn():
    c = http.client.HTTPConnection(HOST, PORT, timeout=35)
    c.connect()
    return c


def arm(ctrl, approach, trial, base=200, jitter=300):
    body = json.dumps({"approach": approach, "trial": trial,
                       "baseDelayMs": base, "jitterMs": jitter})
    ctrl.request("POST", "/control/arm", body, {"Content-Type": "application/json"})
    ctrl.getresponse().read()


def trial_once(approach, trial):
    fire = _conn()                       # the connection we will fire /buy on
    fire.request("GET", "/health")       # warm it: socket is now hot & idle
    fire.getresponse().read()

    ctrl = _conn()
    detect = _conn()

    # Arm FIRST (resets state -> ARMED and schedules a hidden release >=200ms out),
    # THEN attach the long-poll. This avoids reading a stale RELEASED state left over
    # from the previous trial. The long-poll handler is edge-safe either way: if the
    # release has not happened it blocks; if it already has it returns fresh data.
    arm(ctrl, approach, trial)
    detect.request("GET", "/status/longpoll")

    resp = detect.getresponse()          # blocks until the server releases
    resp.read()
    t_detect = time.perf_counter_ns()

    # FIRE — reuse the already-open, already-warm connection. No handshake here.
    fire.request("GET", f"/buy?approach={approach}&trial={trial}")
    data = json.loads(fire.getresponse().read())
    t_fired = time.perf_counter_ns()

    for c in (fire, ctrl, detect):
        try: c.close()
        except Exception: pass

    if not data.get("ok"):
        return None
    return {
        "server_latency_ns": int(data["latency_ns"]),
        "client_fire_ns": t_fired - t_detect,   # local detect->/buy-response
    }


def summarize(name, samples):
    xs = sorted(s["server_latency_ns"] / 1e6 for s in samples)  # -> ms
    p = lambda q: xs[min(len(xs) - 1, int(q * len(xs)))]
    print(f"\n{name}  (n={len(xs)})  server release->hit, milliseconds")
    print(f"  min {xs[0]:.3f}   median {statistics.median(xs):.3f}   "
          f"p95 {p(0.95):.3f}   max {xs[-1]:.3f}   mean {statistics.mean(xs):.3f}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=30)
    ap.add_argument("--approach", default="http-direct")
    ap.add_argument("--lang", default="python")
    args = ap.parse_args()

    os.makedirs(RESULTS_DIR, exist_ok=True)
    rows = []
    for i in range(args.trials):
        r = trial_once(args.approach, i)
        if r:
            rows.append({"approach": args.approach, "lang": args.lang, "trial": i, **r})
        time.sleep(0.03)

    out = os.path.join(RESULTS_DIR, f"{args.approach}_{args.lang}.csv")
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["approach", "lang", "trial",
                                          "server_latency_ns", "client_fire_ns"])
        w.writeheader()
        w.writerows(rows)

    summarize(f"{args.approach} [{args.lang}]", rows)
    print(f"  wrote {out}")


if __name__ == "__main__":
    main()
