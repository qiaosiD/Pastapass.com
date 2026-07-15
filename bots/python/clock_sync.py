#!/usr/bin/env python3
"""
Clock sync + launch countdown against a real-or-mock /api/server-time endpoint.

You cannot trust your local clock to know when a drop fires. The server's `launch`
timestamp is in the SERVER's clock; your machine's clock may be off by tens of ms to
seconds. This measures the offset (NTP / Cristian's algorithm) so you can convert
`launch` into YOUR clock and fire at exactly the right instant.

    offset = server_now - (t0 + t1)/2           # server ahead of you by `offset`
    local_launch = launch - offset              # when to fire, on YOUR clock
    precision ≈ ± best_rtt / 2                   # you can't sync tighter than this

Usage:
    # real site — tells you exactly when the drop is, and your clock error:
    python3 bots/python/clock_sync.py --url https://pastapass.com/api/server-time

    # local mock:
    python3 bots/python/clock_sync.py --url http://127.0.0.1:3000/api/server-time

    # live-updating countdown:
    python3 bots/python/clock_sync.py --url <...> --watch
"""
import argparse
import json
import statistics
import time
import urllib.request


def sample_once(url):
    t0 = time.time()
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=10) as r:
        body = json.loads(r.read())
        http_date = r.headers.get("Date")
        x_cache = r.headers.get("X-Cache", "")
        age = r.headers.get("Age", "")
    t1 = time.time()
    return {
        "rtt": t1 - t0,
        "offset": (body["now"] / 1000.0) - (t0 + t1) / 2.0,  # seconds, server-ahead
        "launch": body.get("launch"),
        "is_live": body.get("is_live"),
        "server_now": body["now"] / 1000.0,
        "x_cache": x_cache,
        "age": age,
    }


def measure(url, samples=25, keep_frac=0.3, gap=0.05):
    """Return (offset_s, best_rtt_s, launch_ms, is_live, n, cache_note).

    gap: seconds between samples. Use a small gap (e.g. 0.01) + few samples for a fast
    re-sync burst right before the drop.
    """
    xs = []
    cache_flags = set()
    for _ in range(samples):
        try:
            s = sample_once(url)
            xs.append(s)
            if s["x_cache"]:
                cache_flags.add(s["x_cache"])
        except Exception:
            pass
        time.sleep(gap)
    if not xs:
        raise SystemExit("no samples — is the endpoint reachable?")
    xs.sort(key=lambda s: s["rtt"])            # lowest RTT first = least noisy
    k = max(1, int(len(xs) * keep_frac))
    best = xs[:k]
    offset = statistics.median(s["offset"] for s in best)
    # caching sanity check: if /api/server-time is edge-cached, `now` is stale and the
    # offset will look huge / drift. Flag it.
    spread = max(s["offset"] for s in best) - min(s["offset"] for s in best)
    cache_note = ""
    if any("Hit" in f for f in cache_flags):
        cache_note = f"WARNING: response was CDN-cached ({cache_flags}) — `now` may be stale"
    elif spread > 1.0:
        cache_note = f"WARNING: offset spread {spread*1000:.0f} ms across low-RTT samples — clock reading is noisy or cached"
    return offset, xs[0]["rtt"], xs[0]["launch"], xs[0]["is_live"], len(xs), cache_note


def fmt_countdown(seconds):
    seconds = max(0, seconds)
    d, rem = divmod(int(seconds), 86400)
    h, rem = divmod(rem, 3600)
    m, s = divmod(rem, 60)
    parts = []
    if d: parts.append(f"{d}d")
    parts.append(f"{h:02d}h {m:02d}m {s:02d}s")
    return " ".join(parts)


def report(url):
    offset, best_rtt, launch_ms, is_live, n, cache_note = measure(url)
    now_local = time.time()
    launch_s = launch_ms / 1000.0
    local_launch = launch_s - offset          # launch, expressed on YOUR clock
    remaining = local_launch - now_local

    ahead = "ahead of" if offset > 0 else "behind"
    print(f"\n  Clock sync vs {url}")
    print(f"  ---------------------------------------------------------------")
    print(f"  samples used            {n}")
    print(f"  your clock is           {abs(offset)*1000:8.1f} ms  {ahead} the server")
    print(f"  best round-trip (RTT)   {best_rtt*1000:8.1f} ms   → sync precision ± {best_rtt*1000/2:.1f} ms")
    print(f"  is_live                 {is_live}")
    print(f"  ---------------------------------------------------------------")
    print(f"  launch (server clock)   {time.strftime('%Y-%m-%d %H:%M:%S UTC', time.gmtime(launch_s))}")
    print(f"  launch (your local)     {time.strftime('%Y-%m-%d %H:%M:%S %Z', time.localtime(local_launch))}")
    print(f"  fire your clock at      {time.strftime('%Y-%m-%d %H:%M:%S.', time.localtime(local_launch))}"
          f"{int((local_launch%1)*1000):03d} local  (= server launch, offset-corrected)")
    print(f"  TIME REMAINING          {fmt_countdown(remaining)}")
    if cache_note:
        print(f"  !! {cache_note}")
    print()
    return offset, best_rtt, launch_ms, is_live


def watch(url):
    offset, best_rtt, launch_ms, _, _, _ = measure(url)
    launch_s = launch_ms / 1000.0
    try:
        while True:
            remaining = (launch_s - offset) - time.time()
            print(f"\r  T-minus {fmt_countdown(remaining)}   (offset {offset*1000:+.0f} ms, ±{best_rtt*1000/2:.0f} ms)   ",
                  end="", flush=True)
            if remaining <= 0:
                print("\n  LAUNCH.");
                break
            time.sleep(0.2)
    except KeyboardInterrupt:
        print()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:3000/api/server-time")
    ap.add_argument("--watch", action="store_true", help="live-updating countdown")
    args = ap.parse_args()
    if args.watch:
        watch(args.url)
    else:
        report(args.url)


if __name__ == "__main__":
    main()
