// POST /api/ingest — write benchmark rows into D1.
//
// This is the ONLY write path, and it is private: the public dashboard is read-only.
// Callers must send  `Authorization: Bearer <INGEST_TOKEN>`  matching the secret set with
//   npx wrangler pages secret put INGEST_TOKEN
//
// Body: { "run_id"?: string, "rows": [ { approach, lang, trial, server_latency_ns, client_fire_ns? }, ... ] }
// The local uploader (benchmark/upload.py) produces exactly this shape from the results CSVs.

const MAX_ROWS = 10000; // per request — a sane abuse ceiling for a portfolio backend

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function unauthorized(env) {
  // If no token is configured at all, refuse writes rather than fail open.
  return json({ ok: false, error: env.INGEST_TOKEN ? "unauthorized" : "ingest-token-not-configured" }, 401);
}

function tokenOk(request, env) {
  if (!env.INGEST_TOKEN) return false;
  const header = request.headers.get("authorization") || "";
  const [scheme, value] = header.split(" ");
  return scheme === "Bearer" && value && value === env.INGEST_TOKEN;
}

// Coerce one incoming record into a clean, typed row — or null if it's unusable.
function clean(row) {
  if (!row || typeof row !== "object") return null;
  const approach = String(row.approach || "").trim();
  const latency = Number(row.server_latency_ns);
  if (!approach || !Number.isFinite(latency) || latency < 0) return null;
  const clientFire = Number(row.client_fire_ns);
  return {
    approach,
    lang: String(row.lang || "?").trim() || "?",
    trial: Number.isFinite(Number(row.trial)) ? Math.trunc(Number(row.trial)) : 0,
    server_latency_ns: Math.trunc(latency),
    client_fire_ns: Number.isFinite(clientFire) ? Math.trunc(clientFire) : null,
  };
}

export async function onRequestPost({ request, env }) {
  if (!tokenOk(request, env)) return unauthorized(env);
  if (!env.DB) return json({ ok: false, error: "d1-not-bound" }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid-json" }, 400);
  }

  const incoming = Array.isArray(body?.rows) ? body.rows : [];
  if (incoming.length === 0) return json({ ok: false, error: "no-rows" }, 400);
  if (incoming.length > MAX_ROWS) return json({ ok: false, error: "too-many-rows", max: MAX_ROWS }, 413);

  const runId = (typeof body.run_id === "string" && body.run_id.trim()) || crypto.randomUUID();
  const rows = incoming.map(clean).filter(Boolean);
  if (rows.length === 0) return json({ ok: false, error: "no-valid-rows" }, 400);

  const stmt = env.DB.prepare(
    `INSERT INTO measurements (run_id, approach, lang, trial, server_latency_ns, client_fire_ns)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const batch = rows.map((r) =>
    stmt.bind(runId, r.approach, r.lang, r.trial, r.server_latency_ns, r.client_fire_ns)
  );

  try {
    await env.DB.batch(batch);
  } catch (err) {
    return json({ ok: false, error: "db-write-failed", detail: String(err) }, 500);
  }

  return json({ ok: true, run_id: runId, inserted: rows.length, skipped: incoming.length - rows.length });
}

// Only POST is defined here, so Pages returns 405 for every other method automatically.
