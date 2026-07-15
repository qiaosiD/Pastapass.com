# Deploy the dashboard to Vercel

The dashboard (`web/`) is a **static site** — no backend to run. It reads a committed
`web/results.json`, so "logging an A/B test" is just: run the benchmark → regenerate that
JSON → commit → push. Vercel auto-redeploys on every push.

> There's also a Cloudflare version in [`DEPLOY.md`](DEPLOY.md) (live API + D1). This Vercel
> path is simpler and needs no database — pick one.

## The part only you can do (needs your Vercel account)

I can build and verify everything locally, but I **cannot** log into your Vercel account or
push the deploy — that's yours. Two ways, either is a few minutes:

### Option A — Import the repo (recommended, auto-deploys on push)
1. Go to **vercel.com → Add New → Project → Import Git Repository**.
2. Sign in with GitHub, pick **`qiaosiD/Pastapass.com`**.
3. Vercel reads the committed **`vercel.json`** (`outputDirectory: web`), so **Framework = Other, no build command** — leave the defaults.
   - If it asks for a **Root Directory**, either leave it at the repo root (vercel.json points to `web/`) or set it to **`web`** — both work.
4. **Deploy.** Every future `git push` to `main` redeploys automatically.

### Option B — Vercel CLI
```bash
npm i -g vercel
cd "/Users/joe/Desktop/Claude/Active Projects/PastaPass.com"
vercel          # first run: opens a browser to log in, links the project
vercel --prod   # publish to your production URL
```

## Creating & logging an A/B test

**Experiments** are the main way to track a test — a hypothesis, the variants you compared,
and the outcome — each rendered as its own page under `/experiment.html?id=…`:

```bash
python3 benchmark/experiment.py new --title "…" --hypothesis "…" --metric p50_ms \
    --method "what you did"
python3 benchmark/experiment.py add-variant --id 003 --key control   --name "…" --approach http-direct --lang python
python3 benchmark/experiment.py add-variant --id 003 --key treatment --name "…" --approach http-direct --lang rust
python3 benchmark/experiment.py run       --id 003          # runs the bots, records the winner
python3 benchmark/experiment.py conclude  --id 003 --conclusion "…" --decision "…"
python3 benchmark/experiment.py build                       # → web/experiments.json
git add web/experiments.json experiments/ && git commit && git push   # you own this → Vercel redeploys
```

`experiment.py list` shows them all. Registered arms today: `http-direct` (python/node/rust),
`browser-observer` (python), `browser-hybrid` (python) — add more in the `BOTS` table.

There's also a lighter **run-log** — every raw benchmark sweep, no narrative:

```bash
./run-all.sh && python3 benchmark/build_dashboard_data.py --label "loopback sweep"
git add web/results.json && git commit && git push
```

Everything is versioned in git, so every published number is reproducible from the commit.

## Notes
- **No env vars, no database.** The whole thing is static + a JSON file.
- Before the first push, `web/results.json` already holds real runs, so the site shows live
  data immediately (not the sample ribbon).
- Want *live* logging (POST results from any machine without a commit)? That needs a store —
  Vercel KV or Postgres — which you'd provision in your Vercel dashboard; ask and I'll wire the
  `api/` functions for it. For a portfolio dashboard, the committed-JSON approach is cleaner.
