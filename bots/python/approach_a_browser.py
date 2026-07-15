#!/usr/bin/env python3
"""
Approach A — Real browser + MutationObserver (Playwright).

This is the most *realistic* strategy: a genuine Chromium with real cookies, real JS,
real rendering. A MutationObserver installed before navigation watches the DOM, and the
instant the <button id="buy"> node is inserted it calls .click() synchronously. The
button's own click handler fires the underlying /buy request.

It is also the SLOWEST of the three, because the click travels through the browser's
event loop and the page's fetch stack. That trade — speed for realism/anti-bot cover —
is the whole point of benchmarking it against B and C.

Setup (one time):
    pip install playwright
    python3 -m playwright install chromium

Run:
    python3 bots/python/approach_a_browser.py --trials 10
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

OBSERVER = """
(() => {
  const clickWhenReady = () => {
    const obs = new MutationObserver(() => {
      const b = document.getElementById('buy');
      if (b) { window.__t_obs_click = performance.now(); b.click(); obs.disconnect(); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.documentElement) clickWhenReady();
  else document.addEventListener('DOMContentLoaded', clickWhenReady);
})();
"""


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
    ap.add_argument("--approach", default="browser-observer")
    ap.add_argument("--lang", default="python")
    ap.add_argument("--headed", action="store_true", help="show the browser window")
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
        page.add_init_script(OBSERVER)     # installed before every navigation
        for i in range(args.trials):
            page.goto(f"{BASE}/?mode=button&trial={i}")
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
