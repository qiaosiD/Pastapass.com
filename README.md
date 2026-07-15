# MockPasta — sniper-bot benchmark rig

A/B tests three "click the button the instant it appears" strategies against a **local
mock target you control**, and measures each one with **sub-millisecond, clock-sync-free**
timing. Build strategy first, tune it against the mock, and never hammer a real site
during development.

> **Reality check on "1 millisecond."** There are two different moments:
> 1. **1 ms after the button appears in _your browser_** → achievable (this repo measures ~0.4–3 ms depending on strategy).
> 2. **1 ms after the sale opens on _their server_** → **impossible for anyone.** The signal must cross the network to you first — that's tens of milliseconds minimum, before any code runs. No tool beats the speed of light down a fiber.
>
> So the winnable goal is: be **pre-loaded, authenticated, warmed up**, and react faster than everyone else the instant the button exists. This rig tells you which strategy + language does that best.

---

## The 3 approaches

| # | Strategy | How it detects & fires | Speed | Robustness | Best infra |
|---|----------|------------------------|-------|------------|-----------|
| **A** | **Real browser + MutationObserver** | Genuine Chromium; an observer installed before load watches the DOM and clicks `#buy` synchronously the instant it's inserted | Slowest (click travels through the browser event loop + page fetch stack) | Highest — real cookies, JS, anti-bot cover | Local Mac or VPS |
| **B** | **Headless HTTP-direct + pre-warmed socket** | No browser. Keeps a keep-alive socket open, long-polls for the "live" edge, fires raw `GET /buy` the instant it arrives | Fastest — raw sockets, zero rendering | Lowest — must reverse-engineer the real request; brittle if the site changes | **VPS in the same region as the target's origin** |
| **C** | **Hybrid: warm browser + injected `fetch()`** | Real browser session (keeps auth/anti-bot cover of A) but fires the underlying request directly on the release signal — skips render→observe→click | Near-B | High | Local or VPS |

**Rule of thumb:** start with **C** for a real drop (browser realism + near-raw speed). Fall
back to **A** if the site's anti-bot needs a fully genuine click. Move to **B** only if you've
reverse-engineered the endpoint and need the absolute floor.

---

## Infra paths

1. **Local (your Mac).** Simplest. Latency = your home connection's RTT to the target. Fine for many drops; this is where you develop and benchmark.
2. **VPS in the target's region** (e.g. AWS `us-east-1` if the site is there). Cuts network RTT from ~50 ms to a few ms. This is what serious snipers use — and for Approach B it's the single biggest speed lever, far bigger than language choice.
3. **Edge / serverless (Vercel functions, Lambda).** *Anti-pattern for the firing bot* — cold starts and no persistent warm connection. Good only for **hosting the static page** or a **scheduled trigger**, not for the time-critical click.

**Where does GitHub fit?** GitHub is for **storing the code** (version control). Don't run the
time-critical click on **GitHub Actions** — its cron is minute-granular and frequently delayed
by minutes, and runners sit in a random datacenter far from the target. Host code on GitHub, run
the bot on path #1 or #2.

---

## Benchmark methodology (why the numbers are trustworthy)

The trap in A/B testing this is **clock sync**: a timestamp on the bot's machine vs. one on the
server are not comparable at microsecond scale. So the mock server is the **single clock of
record**:

- stamps `t_release` (via `process.hrtime.bigint()`, monotonic ns) the instant it makes the button live
- stamps `t_hit` the instant `GET /buy` lands
- **score = `t_hit − t_release`**, both from the _same clock in the same process_ → zero sync error

Every approach ends by hitting the **same `/buy` endpoint**, so the number is directly comparable
across Python / Node / Go / browser. The release moment is **jittered and hidden** from the bot, so
a strategy must genuinely *react*, not predict the clock.

- **Loopback (default):** isolates pure **code/strategy overhead** (no network noise). Best for A/B-ing the code.
- **Deployed target (VPS/Render):** run the same `server.js` remotely to see **realistic RTT** dominate — this is where you confirm the "1 ms" reality check for yourself.

> **Vercel note.** Vercel *serverless functions are stateless* — they can't hold `t_release` in
> memory between the release and the hit, which breaks the single-clock method. Host the **static
> page** on Vercel if you like, but run the **timing server** as an always-on process (local, a VPS,
> or Render/Railway/Fly).

---

## Measured results (this machine, loopback)

Server-measured **release → hit**, milliseconds, fastest first:

| approach [lang] | n | min | median | p95 | max | mean |
|---|---|---|---|---|---|---|
| **B** http-direct **[rust]** | 30 | **0.308** | **0.735** | 1.914 | 2.080 | 0.839 |
| **B** http-direct **[python]** | 30 | 0.436 | 0.941 | 1.619 | 2.416 | 1.009 |
| **B** http-direct **[node]** | 30 | 0.640 | 1.428 | 2.805 | 3.510 | 1.565 |
| **C** browser-hybrid **[python]** | 12 | 2.898 | 3.122 | 5.519 | 5.519 | 3.495 |
| **A** browser-observer **[python]** | 12 | 2.665 | 3.512 | 8.604 | 8.604 | 4.315 |

**Takeaways:**
- **Rust (raw `TcpStream`, no async runtime) is the floor** — ~0.3 ms min / 0.74 ms median.
- The three HTTP-direct languages cluster within ~1 ms of each other. **The *approach* matters far more than the *language*** — Python and Node even swap places run-to-run (both are GC'd and within noise at n=30).
- **Browser approaches are 3–4× slower with much fatter tails** (Approach A's p95 hits 8.6 ms) because the action travels through the browser event loop + page fetch stack. **Hybrid (C) beats observer (A)** by skipping the render→observe→click chain — as predicted.
- This is all **loopback (zero network)**. On a deployed target add tens of ms of RTT on top of *every* row — which dwarfs all these differences and is exactly why **"warm, authenticated, and near the origin" beats "faster language."**

*Reproduce:* `./run-all.sh` (add Go via [go.dev/dl](https://go.dev/dl/) for the other compiled tier).

---

## Quickstart

```bash
# 1. start the mock target (zero dependencies, just Node)
node mock-site/server.js            # http://127.0.0.1:3000

# 2. in another shell, run the runnable tiers
python3 bots/python/approach_b_http.py --trials 30 --lang python
node    bots/node/approach_b_http.mjs --trials 30 --lang node

# 3. see the comparison table
python3 benchmark/aggregate.py
```

Or everything at once (starts the server, runs every available bot, prints the table, cleans up):

```bash
./run-all.sh
TRIALS=50 ./run-all.sh
```

### Browser approaches (A & C)

```bash
pip install playwright && python3 -m playwright install chromium
python3 bots/python/approach_a_browser.py --trials 10     # DOM observer + click
python3 bots/python/approach_c_hybrid.py  --trials 10     # injected fetch
python3 bots/python/approach_a_browser.py --trials 10 --headed   # watch it live
```

### Compiled tier

```bash
# Rust — absolute floor, std-only (no crates), measured fastest here
# install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
rustc -O bots/rust/approach_b_http.rs -o /tmp/rustbot && /tmp/rustbot --trials 30

# Go — the other compiled option
# install Go: https://go.dev/dl/
go run bots/go/approach_b_http.go --trials 30 --lang go
```

The Rust bot is deliberately **std-only** — raw `TcpStream` + a hand-rolled minimal HTTP/1.1 client
with Nagle off. No async runtime, no framework: that's why it posts the lowest floor in the table.

---

## Repo layout

```
mock-site/
  server.js            zero-dep Node mock target + single-clock timing authority
  public/index.html    the drop page (SSE-driven button; ?mode=button | ?mode=direct)
bots/
  python/approach_b_http.py     Approach B — HTTP-direct (stdlib only)  ← baseline
  python/approach_a_browser.py  Approach A — Playwright + MutationObserver
  python/approach_c_hybrid.py   Approach C — Playwright + injected fetch
  node/approach_b_http.mjs      Approach B in Node (faster tier)
  go/approach_b_http.go         Approach B in Go   (compiled tier)
  rust/approach_b_http.rs       Approach B in Rust (std-only, absolute floor)
benchmark/
  aggregate.py         merges results/*.csv into one sorted table
  results/             per-run CSVs (gitignored)
run-all.sh             one-command benchmark
```

### Server contract (any language can implement a bot against this)

| endpoint | purpose |
|---|---|
| `POST /control/arm` `{approach,trial,baseDelayMs,jitterMs}` | reset → ARMED; schedule a hidden, jittered release |
| `GET /status/longpoll` | resolves the instant the server releases (HTTP bots) |
| `GET /events` | SSE stream; emits a `release` event (browser bots) |
| `GET /buy?approach=&trial=` | stamps `t_hit`, returns `{latency_ns}` |
| `GET /results/last`, `GET /results` | inspect measured results |
| `POST /control/reset` | back to IDLE, clear results |

**Correct arm order (matters):** `arm` **first**, then attach your long-poll/SSE listener — arming
resets any stale `RELEASED` state, and the ≥200 ms base delay guarantees you're listening before
the release edge.

---

## A note on the real target

This rig only ever talks to the **local mock** — that's deliberate and keeps development clean.
Before pointing anything at the actual site: automated buying typically **violates a retailer's
Terms of Service** (they can block the traffic or void the order), and this tooling **stops at the
click / add-to-cart** — it does not, and should not, automate entering your payment-card details.
Buying one pass for yourself isn't the same as scalping event tickets, but know the ToS risk going in.
