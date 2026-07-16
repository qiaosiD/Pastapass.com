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
  "conn-warm":        { tag: "W", name: "Warm socket",      color: "#f4c95d" },
  "conn-cold":        { tag: "K", name: "Cold connect",     color: "#6ea8fe" },
  "fire-proactive":   { tag: "P", name: "Proactive",        color: "#7ee0a8" },
  "fire-reactive":    { tag: "R", name: "Reactive",         color: "#e0483a" },
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

// --- design-space explainer: plain-English "what each factor/level means" ---
const FACTORS = [
  {
    key: "language", name: "Language", exp: "001",
    what: "Which programming language the sniper bot is written in — the raw execution speed underneath the strategy.",
    levels: [
      { name: "Rust", desc: "Compiled straight to native code with no garbage collector, so it posts the lowest, steadiest floor." },
      { name: "Python", desc: "Interpreted and quick to iterate on — a hair slower with a slightly fatter tail, but far easier to write." },
      { name: "Node", desc: "JavaScript on a fast JIT engine: lands between the two, close to Python." },
    ],
    implication: "Rust wins the floor (~0.59 vs ~1.18 ms median), but all three cluster within ~1 ms — the strategy matters far more than the language.",
  },
  {
    key: "transport", name: "Transport", exp: "002",
    what: "How the bot actually delivers the purchase — through a full real browser, or straight over the wire.",
    levels: [
      { name: "Browser + observer", desc: "A real Chromium loads the page like a human and a MutationObserver clicks BUY the instant it appears. Most realistic, but a whole browser sits in the path — slowest." },
      { name: "HTTP-direct", desc: "No browser at all — just a raw HTTP request (HyperText Transfer Protocol, the plain web request under every click) fired at the buy endpoint. Fastest, but brittle to build." },
      { name: "Hybrid", desc: "Keeps a real, logged-in browser for anti-bot cover, but fires the underlying request from in-page JavaScript. Near-raw speed with a browser's legitimacy." },
    ],
    implication: "Skipping the browser is ~4–5× faster than a rendered click; the hybrid is the pragmatic middle — browser cover at nearly raw speed.",
  },
  {
    key: "connection", name: "Connection state", exp: "003",
    what: "Whether the network connection is opened ahead of time, or at the last second when the drop fires.",
    levels: [
      { name: "Cold connect", desc: "Opens the socket only after it detects the drop, so you pay the TCP/TLS handshake inside the fire window." },
      { name: "Warm socket", desc: "Pre-opens and holds the connection before the drop, so the handshake is already paid when it's time to fire." },
    ],
    implication: "Pre-warming shaves ~26% off the median. On a real TLS endpoint the cold penalty is a full handshake (tens of ms) — so warming is decisive.",
  },
  {
    key: "mode", name: "Mode", exp: "004",
    what: "How the bot decides WHEN to fire — wait and react to the signal, or fire on a pre-synced clock.",
    levels: [
      { name: "Reactive", desc: "Long-polls the \"is it live?\" endpoint and fires the moment it sees the release — but first pays a detect round-trip." },
      { name: "Proactive", desc: "Syncs to the server's clock and fires exactly at the launch instant, skipping the detect round-trip (keeping a reactive fallback)." },
    ],
    implication: "Proactive beats reactive by ~20%, and the edge grows with network latency — it can save nearly a whole round-trip.",
  },
];

function showFactor(key, levelIdx) {
  const f = FACTORS.find((x) => x.key === key);
  const detail = document.getElementById("ds-detail");
  if (!f || !detail) return;
  detail.innerHTML = `
    <div class="ds-detail-card">
      <div class="ds-detail-head"><h4>${f.name}</h4><a class="ds-exp-link" href="/experiment.html?id=${f.exp}">experiment #${f.exp} →</a></div>
      <p class="ds-what">${f.what}</p>
      <div class="ds-levels">
        ${f.levels.map((lv, i) => `<div class="ds-level ${i === levelIdx ? "is-active" : ""}"><span class="ds-level-name">${lv.name}</span> <span class="ds-level-desc">${lv.desc}</span></div>`).join("")}
      </div>
      <div class="ds-implication"><span class="k">Why it matters</span>${f.implication}</div>
    </div>`;
}

function renderDesignSpace() {
  const tb = document.getElementById("ds-tbody");
  if (!tb) return;
  tb.innerHTML = FACTORS.map((f) => `
    <tr>
      <td><button class="ds-factor-btn" data-factor="${f.key}">${f.name}</button></td>
      <td><div class="ds-levels-cell">${f.levels
        .map((lv, i) => `<button class="ds-chip" data-factor="${f.key}" data-level="${i}">${lv.name}</button>`)
        .join("")}</div></td>
    </tr>`).join("");
  document.getElementById("ds-detail").innerHTML =
    '<p class="ds-detail-prompt">👆 Tap any factor or level above to see what it means — and why it matters.</p>';
  document.getElementById("design-space").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-factor]");
    if (!b) return;
    showFactor(b.dataset.factor, b.dataset.level != null ? +b.dataset.level : -1);
    document.querySelectorAll("#design-space .ds-chip, #design-space .ds-factor-btn")
      .forEach((x) => x.classList.toggle("is-active", x === b));
  });
}

(async function main() {
  renderDesignSpace();
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
