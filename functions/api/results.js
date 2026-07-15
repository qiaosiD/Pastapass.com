// GET /api/results — public, read-only aggregates for the dashboard.
//
// Returns one entry per (approach, lang) group with min / p50 / p95 / max / mean in
// milliseconds, sorted fastest-first by median. Percentiles use the SAME nearest-rank
// convention as benchmark/aggregate.py so the website and the local table never disagree.

const CACHE_SECONDS = 60;
const ROW_LIMIT = 200000; // bound the read; portfolio-scale data is far below this

const headers = {
  "content-type": "application/json; charset=utf-8",
  "access-control-allow-origin": "*",
  "cache-control": `public, max-age=${CACHE_SECONDS}`,
};

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers });

// nearest-rank percentile, matching aggregate.py: xs[min(len-1, int(q*len))]
function pctile(sorted, q) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.trunc(q * sorted.length))];
}

function mean(xs) {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: "d1-not-bound", groups: [], total_measurements: 0, total_runs: 0 }, 500);

  let rows;
  try {
    const res = await env.DB.prepare(
      `SELECT approach, lang, server_latency_ns
         FROM measurements
        ORDER BY approach, lang
        LIMIT ${ROW_LIMIT}`
    ).all();
    rows = res.results || [];
  } catch (err) {
    return json({ error: "db-read-failed", detail: String(err), groups: [] }, 500);
  }

  // Group latencies (ns -> ms) by "approach|lang".
  const buckets = new Map();
  for (const r of rows) {
    const key = `${r.approach}|${r.lang}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { approach: r.approach, lang: r.lang, ms: [] }));
    b.ms.push(Number(r.server_latency_ns) / 1e6);
  }

  const groups = [...buckets.values()].map((b) => {
    const xs = b.ms.sort((a, z) => a - z);
    return {
      key: `${b.approach}|${b.lang}`,
      approach: b.approach,
      lang: b.lang,
      n: xs.length,
      min_ms: xs[0],
      p50_ms: pctile(xs, 0.5),
      p95_ms: pctile(xs, 0.95),
      max_ms: xs[xs.length - 1],
      mean_ms: mean(xs),
    };
  });

  groups.sort((a, b) => a.p50_ms - b.p50_ms); // fastest first

  const runsRes = await env.DB.prepare(`SELECT COUNT(DISTINCT run_id) AS runs FROM measurements`).first();

  return json({
    updated_at: new Date().toISOString(),
    total_measurements: rows.length,
    total_runs: runsRes ? Number(runsRes.runs) : 0,
    groups,
  });
}

// Cheap CORS preflight support, in case the dataset is ever embedded cross-origin.
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "content-type",
    },
  });
}
