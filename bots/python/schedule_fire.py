#!/usr/bin/env python3
"""
Approach B + clock sync — the full "know exactly when, then hit it" pipeline.

This is what you actually run on drop day. It:
  1. syncs your clock to the server's via /api/server-time (NTP-style, see clock_sync.py)
  2. converts the server's `launch` into YOUR clock  (local_launch = launch - offset)
  3. sleeps until just before launch, then RE-SYNCS (clocks drift over hours)
  4. SPIN-WAITS the final milliseconds (OS sleep is too coarse to trust at the end)
  5. fires /api/enter on a pre-warmed connection the instant the server goes live,
     retrying on "not live yet" so a server that flips a hair late doesn't cost you

Demo against the mock (arms a known launch, then races it):
    node mock-site/server.js
    python3 bots/python/schedule_fire.py --launch-in 6

Real-target shape (DON'T point --fire at the real site; this is for your mock / a
target you're authorized to load-test):
    python3 bots/python/schedule_fire.py \
        --time-url https://.../api/server-time --fire-url https://.../api/enter --no-arm
"""
import argparse
import http.client
import json
import time
from urllib.parse import urlparse

from clock_sync import measure


def _conn(url):
    u = urlparse(url)
    return http.client.HTTPConnection(u.hostname, u.port or 80, timeout=35), u.path


def arm(base, launch_in_s):
    u = urlparse(base)
    c = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=10)
    body = json.dumps({"approach": "scheduled", "trial": 0,
                       "baseDelayMs": int(launch_in_s * 1000), "jitterMs": 0})
    c.request("POST", "/control/arm", body, {"Content-Type": "application/json"})
    c.getresponse().read(); c.close()


def spin_until(target_local):
    # OS sleep is coarse (±1–15 ms); coarse-sleep to ~2 ms out, then busy-wait.
    while True:
        dt = target_local - time.time()
        if dt <= 0:
            return
        if dt > 0.02:
            time.sleep(dt - 0.02)
        # else: tight spin


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:3000", help="mock base url (for --arm)")
    ap.add_argument("--time-url", default=None, help="/api/server-time url")
    ap.add_argument("--fire-url", default=None, help="/api/enter (or /buy) url")
    ap.add_argument("--launch-in", type=float, default=6.0, help="seconds until mock launch")
    ap.add_argument("--no-arm", action="store_true", help="don't arm (real target already scheduled)")
    ap.add_argument("--lead-ms", type=float, default=0.0,
                    help="fire this many ms BEFORE local_launch (set ~= one-way latency so the request ARRIVES at launch)")
    args = ap.parse_args()

    time_url = args.time_url or f"{args.base}/api/server-time"
    fire_url = args.fire_url or f"{args.base}/api/enter"

    if not args.no_arm:
        arm(args.base, args.launch_in)

    # 1) initial sync
    offset, rtt, launch_ms, is_live, n, note = measure(time_url, samples=20, gap=0.05)
    if launch_ms is None:
        raise SystemExit("server-time has no launch scheduled (arm it first, or --no-arm on a live target)")
    local_launch = launch_ms / 1000.0 - offset
    print(f"[sync]  offset {offset*1000:+.1f} ms  rtt {rtt*1000:.1f} ms  "
          f"launch in {local_launch - time.time():.2f}s" + (f"  ({note})" if note else ""))

    # 2) pre-warm the fire connection
    fc, fire_path = _conn(fire_url)
    fc.request("GET", "/health"); fc.getresponse().read()   # socket now hot

    # 3) sleep until just before launch, then re-sync tightly (drift correction)
    pre = local_launch - 0.4
    if pre > time.time():
        time.sleep(pre - time.time())
    offset, rtt, launch_ms, _, _, _ = measure(time_url, samples=8, gap=0.01)
    local_launch = launch_ms / 1000.0 - offset
    print(f"[resync] offset {offset*1000:+.1f} ms  rtt {rtt*1000:.1f} ms  "
          f"launch in {local_launch - time.time():.3f}s")

    # 4) spin-wait to the corrected instant (minus optional lead for one-way latency)
    fire_at = local_launch - args.lead_ms / 1000.0
    spin_until(fire_at)

    # 5) fire, retrying on "not live yet"
    t_fire = time.time()
    attempts = 0
    while True:
        attempts += 1
        fc.request("GET", fire_path + "?approach=scheduled&trial=0")
        data = json.loads(fc.getresponse().read())
        if data.get("ok"):
            break
        if time.time() - t_fire > 0.2:
            print("[fire]  gave up after 200 ms of 'not live'"); return
        # tiny backoff then retry the instant it flips
        time.sleep(0.0005)

    landed_after_launch = (time.time() - local_launch) * 1000.0
    server_lat = int(data["latency_ns"]) / 1e6
    print(f"[fire]  HIT on attempt {attempts}  |  fired {landed_after_launch:+.2f} ms vs launch  |  "
          f"server release→hit {server_lat:.3f} ms")


if __name__ == "__main__":
    main()
