// PastaPass dashboard — fetches /api/results and renders the headline stat, a
// log-scale lollipop chart (median dot → p95 line), and the full stats table.
// If the API is unreachable or empty (e.g. before the first upload), it falls back
// to /sample-results.json and shows a "sample data" ribbon.

// Concrete hex (not CSS vars): var() inside SVG presentation attributes like fill=/stroke=
// isn't resolved by every browser. These mirror the palette in styles.css.
const APPROACH = {
  "browser-observer": { tag: "A", name: "Browser observer", color: "#6ea8fe" },
  "http-direct":      { tag: "B", name: "HTTP-direct",      color: "#f4c95d" },
  "browser-hybrid":   { tag: "C", name: "Hybrid",           color: "#e0483a" },
};
const meta = (k) => APPROACH[k] || { tag: "?", name: k, color: "#9aa3b2" };

const fmt = (ms) =>
  ms < 1 ? ms.toFixed(3) : ms < 10 ? ms.toFixed(2) : ms.toFixed(1);

async function load() {
  // Portable across hosts: a live API (Cloudflare/Vercel-KV) if present, else the
  // committed results.json (Vercel static deploy), else bundled sample data.
  for (const url of ["/api/results", "/results.json"]) {
    try {
      const r = await fetch(url, { headers: { accept: "application/json" } });
      if (r.ok) {
        const data = await r.json();
        if (data.groups && data.groups.length) return { data, sample: false };
      }
    } catch (_) { /* try the next source */ }
  }

  const r = await fetch("/sample-results.json");
  return { data: await r.json(), sample: true };
}

function renderHeadline(groups) {
  const fastest = groups[0];
  if (!fastest) return;
  const m = meta(fastest.approach);
  document.getElementById("headline-value").textContent = fmt(fastest.p50_ms);
  document.getElementById("headline-approach").textContent =
    `${m.tag} · ${m.name} [${fastest.lang}]`;
  document.getElementById("headline").hidden = false;
}

// --- log-scale ticks: 1 and 3 per decade across the data range -------------
function logTicks(lo, hi) {
  const ticks = [];
  const start = Math.floor(Math.log10(lo));
  const end = Math.ceil(Math.log10(hi));
  for (let p = start; p <= end; p++) {
    for (const m of [1, 3]) {
      const v = m * 10 ** p;
      if (v >= lo * 0.98 && v <= hi * 1.02) ticks.push(v);
    }
  }
  return ticks;
}

function renderChart(groups) {
  const el = document.getElementById("chart");
  if (!groups.length) { el.innerHTML = '<p class="muted">No measurements yet.</p>'; return; }

  const W = 920, L = 176, R = 60, T = 18, rowH = 48;
  const H = T + groups.length * rowH + 40;
  const plotW = W - L - R;

  const lo = Math.max(1e-3, Math.min(...groups.map((g) => g.min_ms)) * 0.8);
  const hi = Math.max(...groups.map((g) => g.p95_ms)) * 1.18;
  const lgLo = Math.log10(lo), lgHi = Math.log10(hi);
  const x = (ms) => L + ((Math.log10(Math.max(ms, lo)) - lgLo) / (lgHi - lgLo)) * plotW;

  const parts = [`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">`];

  // vertical gridlines + axis labels
  const axisY = T + groups.length * rowH + 8;
  for (const t of logTicks(lo, hi)) {
    const gx = x(t).toFixed(1);
    parts.push(`<line class="grid-line" x1="${gx}" y1="${T}" x2="${gx}" y2="${axisY}" />`);
    parts.push(`<text class="grid-label" x="${gx}" y="${axisY + 16}" text-anchor="middle">${fmt(t)}</text>`);
  }
  parts.push(`<text class="grid-label" x="0" y="${axisY + 16}" text-anchor="start">milliseconds · log scale</text>`);

  // one lollipop row per group
  groups.forEach((g, i) => {
    const cy = T + i * rowH + rowH / 2;
    const m = meta(g.approach);
    const xp50 = x(g.p50_ms), xp95 = x(g.p95_ms);

    parts.push(`<text class="row-label" x="0" y="${cy - 3}">${m.tag} · ${m.name}</text>`);
    parts.push(`<text class="row-lang" x="0" y="${cy + 13}">${g.lang} · n=${g.n}</text>`);

    // median -> p95 connector
    parts.push(`<line class="lolli-line" x1="${xp50.toFixed(1)}" y1="${cy}" x2="${xp95.toFixed(1)}" y2="${cy}" stroke="${m.color}" />`);
    // p95 end tick
    parts.push(`<line class="lolli-p95" x1="${xp95.toFixed(1)}" y1="${cy - 6}" x2="${xp95.toFixed(1)}" y2="${cy + 6}" stroke="${m.color}" />`);
    // median dot
    parts.push(`<circle cx="${xp50.toFixed(1)}" cy="${cy}" r="6" fill="${m.color}" />`);
    // median value above the dot
    parts.push(`<text class="value-label" x="${xp50.toFixed(1)}" y="${cy - 12}" text-anchor="middle" fill="${m.color}">${fmt(g.p50_ms)}</text>`);
  });

  parts.push("</svg>");
  el.innerHTML = parts.join("");
}

function renderTable(groups) {
  const tbody = document.querySelector("#results-table tbody");
  tbody.innerHTML = groups.map((g) => {
    const m = meta(g.approach);
    return `<tr>
      <td><span class="dot" style="background:${m.color}"></span>${m.tag} · ${m.name}</td>
      <td>${g.lang}</td>
      <td class="num">${g.n}</td>
      <td class="num">${fmt(g.min_ms)}</td>
      <td class="num">${fmt(g.p50_ms)}</td>
      <td class="num">${fmt(g.p95_ms)}</td>
      <td class="num">${fmt(g.max_ms)}</td>
      <td class="num">${fmt(g.mean_ms)}</td>
    </tr>`;
  }).join("");
}

// --- the A/B-test log: one row per benchmark run, newest first --------------
function renderRuns(runs) {
  const el = document.getElementById("run-log-body");
  if (!el) return;
  if (!runs || !runs.length) {
    el.innerHTML = '<tr><td colspan="6" class="muted">No runs logged yet.</td></tr>';
    return;
  }
  el.innerHTML = runs
    .map((run, i) => ({ run, n: i + 1 }))
    .reverse()
    .map(({ run, n }) => {
      const f = run.fastest || {};
      const m = meta(f.approach);
      const when = run.at ? new Date(run.at).toLocaleString() : "—";
      return `<tr>
        <td class="num">#${n}</td>
        <td>${when}</td>
        <td>${run.label ? run.label : '<span class="muted">—</span>'}</td>
        <td class="num">${(run.measurements || 0).toLocaleString()}</td>
        <td><span class="dot" style="background:${m.color}"></span>${m.tag} · ${m.name} [${f.lang || "?"}]</td>
        <td class="num">${f.p50_ms != null ? fmt(f.p50_ms) : "—"}</td>
      </tr>`;
    })
    .join("");
}

function renderMeta(data, sample) {
  const parts = [];
  if (data.total_runs) parts.push(`${data.total_runs} run${data.total_runs === 1 ? "" : "s"}`);
  if (data.total_measurements) parts.push(`${data.total_measurements.toLocaleString()} measurements`);
  if (sample) {
    parts.push("sample data");
  } else if (data.updated_at) {
    const d = new Date(data.updated_at);
    if (!isNaN(d)) parts.push(`updated ${d.toLocaleString()}`);
  }
  document.getElementById("results-meta").textContent = parts.length ? "· " + parts.join(" · ") : "";
}

// --- experiments index: one card per tracked A/B test ----------------------
const STATUS_LABEL = { planned: "planned", running: "running", complete: "complete", archived: "archived" };

async function loadExperiments() {
  try {
    const r = await fetch("/experiments.json", { headers: { accept: "application/json" } });
    if (r.ok) return await r.json();
  } catch (_) { /* none published yet */ }
  return null;
}

function renderExperiments(payload) {
  const el = document.getElementById("experiments-list");
  if (!el) return;
  const exps = (payload && payload.experiments) || [];
  if (!exps.length) {
    el.innerHTML = '<p class="muted">No experiments yet — create one with <code>python3 benchmark/experiment.py new</code>.</p>';
    return;
  }
  el.innerHTML = exps.map((e) => {
    const o = e.outcome || {};
    const hyp = e.hypothesis || "";
    const hypShort = hyp.length > 130 ? hyp.slice(0, 128) + "…" : hyp;
    const delta = o.delta_pct != null ? `${o.delta_pct > 0 ? "+" : ""}${o.delta_pct}%` : "";
    const outcome = o.winner_name
      ? `<div class="exp-outcome">
           <span class="exp-winner">🏆 ${o.winner_name}</span>
           <span class="exp-delta">${o.winner_value != null ? fmt(o.winner_value) + " ms" : ""}${delta ? " · " + delta : ""}</span>
         </div>`
      : `<div class="exp-outcome muted">${(e.variants || []).length} variant${(e.variants || []).length === 1 ? "" : "s"} · not run yet</div>`;
    return `<a class="exp-card" href="/experiment.html?id=${encodeURIComponent(e.id)}">
      <div class="exp-card-top">
        <span class="exp-status exp-status--${e.status}">${STATUS_LABEL[e.status] || e.status}</span>
        <span class="exp-id">#${e.id}</span>
      </div>
      <h3>${e.title}</h3>
      <p class="exp-hyp">${hypShort}</p>
      ${outcome}
    </a>`;
  }).join("");
}

(async function main() {
  const { data, sample } = await load();
  const groups = data.groups || [];
  if (sample) document.getElementById("sample-ribbon").hidden = false;
  renderHeadline(groups);
  renderChart(groups);
  renderTable(groups);
  renderRuns(data.runs);
  renderMeta(data, sample);
  renderExperiments(await loadExperiments());
})();

// --- drop countdown (hero) -------------------------------------------------
(function dropCountdown() {
  const DROP = new Date("2026-07-16T14:00:00-04:00"); // the drop — 2:00 PM ET (edit to re-target)
  const $ = (id) => document.getElementById(id);
  const buy = $("drop-buy"), note = $("drop-note"), cap = $("cd-caption");
  if (!buy) return;
  let previewing = false, previewTimer = null;
  const pad = (n) => String(n).padStart(2, "0");

  const setLive = (on) => {
    buy.classList.toggle("is-live", on);
    buy.classList.toggle("is-locked", !on);
  };

  function tick() {
    if (previewing) return;                 // preview owns the button while active
    const ms = DROP.getTime() - Date.now();
    if (ms <= 0) {
      setLive(true);
      ["cd-days", "cd-hours", "cd-mins", "cd-secs"].forEach((id) => { const el = $(id); if (el) el.textContent = "00"; });
      if (cap) cap.textContent = "the drop is live — click as fast as you can";
      return;
    }
    setLive(false);
    const s = Math.floor(ms / 1000);
    const seg = { "cd-days": Math.floor(s / 86400), "cd-hours": pad(Math.floor((s % 86400) / 3600)),
                  "cd-mins": pad(Math.floor((s % 3600) / 60)), "cd-secs": pad(s % 60) };
    for (const id in seg) { const el = $(id); if (el) el.textContent = seg[id]; }
  }

  const prev = $("drop-preview");
  if (prev) prev.addEventListener("click", (e) => {
    e.preventDefault();
    previewing = true;
    setLive(true);
    if (note) note.textContent = "🍝 that's the button lighting up at 2 PM — the bots hit it in under a millisecond.";
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { previewing = false; if (note) note.textContent = ""; tick(); }, 6000);
  });

  buy.addEventListener("click", () => {
    if (buy.classList.contains("is-live")) $("results")?.scrollIntoView({ behavior: "smooth" });
  });

  tick();
  setInterval(tick, 1000);
})();
