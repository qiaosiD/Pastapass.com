# Deploying PastaPass (Cloudflare Pages + Functions + D1)

The public dashboard is **read-only**; only you can write, using a bearer token. Everything
below is on Cloudflare's free tier and nothing sleeps.

> Steps that need **your** Cloudflare account are marked 🔐 — I can't run those for you
> (login, creating resources on your account, attaching a domain). Copy/paste and go.

## Prerequisites
- Node.js 18+ (`node -v`)
- A Cloudflare account (free)
- `npm install` in this folder (installs `wrangler` locally)

## 1. Log in 🔐
```bash
npx wrangler login
```

## 2. Create the D1 database 🔐
```bash
npx wrangler d1 create pastapass
```
Copy the printed `database_id` into [`wrangler.toml`](wrangler.toml) (replace `REPLACE_WITH_YOUR_D1_ID`).

## 3. Create the table
```bash
npm run db:schema          # applies schema.sql to the remote D1
# npm run db:schema:local  # same, but for the local dev database
```

## 4. Deploy the site 🔐
```bash
npm run deploy             # = wrangler pages deploy web
```
First run creates the Pages project (accept the name `pastapass`). You'll get a
`https://pastapass.pages.dev` URL. The D1 binding in `wrangler.toml` is attached automatically.

## 5. Set the ingest token 🔐
Pick any long random string — this is the password your uploader uses.
```bash
npx wrangler pages secret put INGEST_TOKEN --project-name pastapass
# paste the secret when prompted
```

## 6. Upload your benchmark data
Run the benchmark locally, then push the results:
```bash
./run-all.sh                                   # generates benchmark/results/*.csv
PASTAPASS_URL=https://pastapass.pages.dev \
PASTAPASS_TOKEN=<the-secret-from-step-5> \
python3 benchmark/upload.py
```
Refresh the site — the sample data is replaced by your real numbers. Re-run anytime to add more.

## 7. Custom domain (optional) 🔐
In the Cloudflare dashboard → **Workers & Pages → pastapass → Custom domains**, add
`pastapass.com` (Cloudflare walks you through DNS).

## Local development
```bash
npm run db:schema:local    # once, to create the local table
npm run dev                # = wrangler pages dev web  (serves page + functions + local D1)
```
For local ingest, create a `.dev.vars` file with `INGEST_TOKEN=dev-secret` (git-ignored),
then upload against `PASTAPASS_URL=http://localhost:8788`.

## API
| Method | Path           | Auth        | Purpose                                  |
|--------|----------------|-------------|------------------------------------------|
| `GET`  | `/api/results` | public      | Aggregated stats for the dashboard       |
| `POST` | `/api/ingest`  | Bearer token| Insert measurement rows (uploader only)  |
