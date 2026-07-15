#!/usr/bin/env python3
"""
Approach C — Hybrid: warm authenticated browser that fires the underlying request
directly (Playwright + in-page fetch, no DOM click).

The browser is real (so you keep the session, cookies and anti-bot cover of Approach A),
but instead of waiting for a button to render and clicking it, the page fires the
underlying /buy fetch the instant the release signal arrives over SSE. It skips the
whole render-button -> observer -> click -> dispatch chain, so it lands much closer to
the raw HTTP speed of Approach B while still running inside a genuine browser session.

This is usually the sweet spot for real drops: browser realism, near-raw speed.

Setup (one time):
    pip install playwright
    python3 -m playwright install chromium

Run:
    python3 bots/python/approach_c_hybrid.py --trials 10
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
BASE = f"http://{HOST}:{PORT}"
RESULTS_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "benchmark", "results")


def arm(approach, trial, base=200, jitter=300):
    c = http.client.HTTPConnection(HOST, PORT, timeout=35)
    body = json.dumps({"approach": approach, "trial": trial,
                       "baseDelayMs": base, "jitterMs": jitter})
    c.request("POST", "/control/arm", body, {"Content-Type": "application/json"})
    c.getresponse().read()
    c.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=10)
    ap.add_argument("--approach", default="browser-hybrid")
    ap.add_argument("--lang", default="python")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise SystemExit("Playwright not installed. Run:\n"
                         "  pip install playwright && python3 -m playwright install chromium")

    os.makedirs(RESULTS_DIR, exist_ok=True)
    rows = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headed)
        page = browser.new_page()
        for i in range(args.trials):
            # mode=direct => the page fires /buy immediately on the SSE release event.
            page.goto(f"{BASE}/?mode=direct&trial={i}")
            page.wait_for_function("window.__sseReady === true")
            arm(args.approach, i)
            page.wait_for_function("window.__lastBuy !== null", timeout=15000)
            buy = page.evaluate("window.__lastBuy")
            if buy and buy.get("ok"):
                rows.append({"approach": args.approach, "lang": args.lang, "trial": i,
                             "server_latency_ns": int(buy["latency_ns"]),
                             "client_fire_ns": ""})
            time.sleep(0.05)
        browser.close()

    out = os.path.join(RESULTS_DIR, f"{args.approach}_{args.lang}.csv")
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["approach", "lang", "trial",
                                          "server_latency_ns", "client_fire_ns"])
        w.writeheader(); w.writerows(rows)

    xs = sorted(r["server_latency_ns"] / 1e6 for r in rows)
    if xs:
        p = lambda q: xs[min(len(xs) - 1, int(q * len(xs)))]
        print(f"\n{args.approach} [{args.lang}]  (n={len(xs)})  server release->hit, ms")
        print(f"  min {xs[0]:.3f}   median {statistics.median(xs):.3f}   "
              f"p95 {p(0.95):.3f}   max {xs[-1]:.3f}   mean {statistics.mean(xs):.3f}")
    print(f"  wrote {out}")


if __name__ == "__main__":
    main()
