// Detail page for one tracked experiment. Reads ?id=… , fetches /experiments.json
// (write-up + summary metrics) and /research.json (raw per-trial samples), and renders
// the full overview: hypothesis, method, an interactive per-variant distribution showing
// EVERY run (strip / raincloud / box), the summary table, and the outcome.

const APPROACH = {
  "browser-observer": { tag: "A", name: "Browser observer", color: "#6ea8fe" },
  "http-direct":      { tag: "B", name: "HTTP-direct",      color: "#f4c95d" },
  "browser-hybrid":   { tag: "C", name: "Hybrid",           color: "#e0483a" },
  "conn-warm":        { tag: "W", name: "Warm socket",      color: "#f4c95d" },
  "conn-cold":        { tag: "K", name: "Cold connect",     color: "#6ea8fe" },
  "fire-proactive":   { tag: "P", name: "Proactive",        color: "#7ee0a8" },
  "fire-reactive":    { tag: "R", name: "Reactive",         color: "#e0483a" },
};
// Distinct per-variant palette so same-approach variants (e.g. three HTTP-direct langs) stay separable.
const PALETTE = ["#f4c95d", "#7ee0a8", "#6ea8fe", "#c792ea", "#f0a24b"];
const meta = (k) => APPROACH[k] || { tag: "?", name: k, color: "#9aa3b2" };
const fmt = (ms) => (ms == null ? "—" : ms < 1 ? ms.toFixed(3) : ms < 10 ? ms.toFixed(2) : ms.toFixed(1));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let ARM_SAMPLES = {};      // "approach|lang" -> arm {samples, stats, ci_median}
let VAR_COLOR = {};        // variant key -> color
let SERIES = [];           // [{key,name,approach,lang,color,samples,stats,ci}]
let expFmt = "strip";

const logTicks = (lo, hi) => {
  const t = [];
  for (let p = Math.floor(Math.log10(lo)); p <= Math.ceil(Math.log10(hi)); p++)
    for (const m of [1, 2, 5]) { const v = m * 10 ** p; if (v >= lo * 0.98 && v <= hi * 1.02) t.push(v); }
  return t;
};
const jitter = (i) => { const x = Math.sin(i * 12.9898 + 1.3) * 43758.5453; return 2 * (x - Math.floor(x)) - 1; };
const SVG_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// ===========================================================================
//  Per-variant distribution (every run)
// ===========================================================================
function buildSeries(variants) {
  return variants.map((v, i) => {
    const arm = ARM_SAMPLES[`${v.approach}|${v.lang}`];
    return {
      key: v.key, name: v.name, approach: v.approach, lang: v.lang,
      color: VAR_COLOR[v.key] || meta(v.approach).color,
      samples: arm ? arm.samples : [],
      stats: arm ? arm.stats : (v.metrics ? { p50: v.metrics.p50_ms, q25: v.metrics.p50_ms, q75: v.metrics.p95_ms, min: v.metrics.min_ms, max: v.metrics.max_ms, mean: v.metrics.mean_ms, std: 0.1 } : null),
      ci: arm ? arm.ci_median : null,
    };
  }).filter((s) => s.stats);
}

function scaleX(L, plotW) {
  const mins = SERIES.map((s) => s.stats.min), maxs = SERIES.map((s) => s.stats.max);
  const lo = Math.max(1e-3, Math.min(...mins) * 0.82), hi = Math.max(...maxs) * 1.12;
  const lgLo = Math.log10(lo), lgHi = Math.log10(hi);
  return { x: (ms) => L + ((Math.log10(Math.max(ms, lo)) - lgLo) / (lgHi - lgLo)) * plotW, lo, hi };
}

const pt = (cx, cy, r, color, label) =>
  `<circle class="dpoint" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${color}" data-v="1" data-label="${esc(label)}" />`;

function renderExpRows(fmtName) {
  const W = 820, L = 210, R = 24, T = 12;
  const rowH = fmtName === "raincloud" ? 78 : fmtName === "box" ? 52 : 60;
  const plotW = W - L - R, H = T + SERIES.length * rowH + 40;
  const { x, lo, hi } = scaleX(L, plotW);
  const axisY = T + SERIES.length * rowH + 8;

  const parts = [`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="${SVG_FONT}">`];
  for (const t of logTicks(lo, hi)) {
    const gx = x(t).toFixed(1);
    parts.push(`<line class="grid-line" x1="${gx}" y1="${T}" x2="${gx}" y2="${axisY}" />`);
    parts.push(`<text class="grid-label" x="${gx}" y="${axisY + 16}" text-anchor="middle">${fmt(t)}</text>`);
  }
  parts.push(`<text class="grid-label" x="0" y="${axisY + 16}" text-anchor="start">milliseconds · log scale</text>`);

  SERIES.forEach((s, i) => {
    const rowTop = T + i * rowH, cy = rowTop + rowH / 2, st = s.stats, color = s.color;
    parts.push(`<text class="row-label" x="0" y="${(rowTop + rowH / 2 - 4).toFixed(1)}">${esc(s.name)}</text>`);
    parts.push(`<text class="row-lang" x="0" y="${(rowTop + rowH / 2 + 12).toFixed(1)}">${esc(s.approach)} · ${esc(s.lang)} · n=${s.samples.length}</text>`);

    if (fmtName === "strip") {
      const band = 15;
      s.samples.forEach((v, k) => parts.push(pt(x(v), cy + jitter(k) * band, 2.7, color, `${s.name} · run #${k} · ${fmt(v)} ms`)));
      parts.push(`<line x1="${x(st.p50).toFixed(1)}" y1="${cy - 20}" x2="${x(st.p50).toFixed(1)}" y2="${cy + 20}" stroke="${color}" stroke-width="2.5" />`);
      parts.push(`<text class="value-label" x="${x(st.p50).toFixed(1)}" y="${(rowTop + 12).toFixed(1)}" text-anchor="middle" fill="${color}">${fmt(st.p50)}</text>`);
    } else if (fmtName === "box") {
      const hh = 11, xq1 = x(st.q25), xq3 = x(st.q75);
      parts.push(`<line class="dwhisk" x1="${x(st.min).toFixed(1)}" y1="${cy}" x2="${xq1.toFixed(1)}" y2="${cy}" stroke="${color}" />`);
      parts.push(`<line class="dwhisk" x1="${xq3.toFixed(1)}" y1="${cy}" x2="${x(st.max).toFixed(1)}" y2="${cy}" stroke="${color}" />`);
      parts.push(`<rect class="dbox" x="${xq1.toFixed(1)}" y="${cy - hh}" width="${Math.max(1, xq3 - xq1).toFixed(1)}" height="${2 * hh}" fill="${color}" fill-opacity="0.16" stroke="${color}" data-v="1" data-label="${esc(`${s.name} · IQR ${fmt(st.q25)}–${fmt(st.q75)} ms`)}" />`);
      parts.push(`<line x1="${x(st.p50).toFixed(1)}" y1="${cy - hh}" x2="${x(st.p50).toFixed(1)}" y2="${cy + hh}" stroke="${color}" stroke-width="2.5" data-v="1" data-label="${esc(`${s.name} · median ${fmt(st.p50)} ms`)}" />`);
      parts.push(`<path d="M ${x(st.mean).toFixed(1)} ${cy - 5} l 5 5 l -5 5 l -5 -5 z" fill="#0d0f14" stroke="${color}" stroke-width="1.4" data-v="1" data-label="${esc(`${s.name} · mean ${fmt(st.mean)} ms`)}" />`);
    } else { // raincloud
      const base = rowTop + 38, vTop = rowTop + 6;
      const grid = [], NG = 64, lgLo = Math.log10(lo), lgHi = Math.log10(hi);
      for (let g = 0; g < NG; g++) grid.push(10 ** (lgLo + (lgHi - lgLo) * (g / (NG - 1))));
      const h = Math.max(0.02, 1.06 * (st.std || 0.05) * Math.pow(Math.max(1, s.samples.length), -0.2));
      const dens = grid.map((g) => { let sum = 0; for (const v of s.samples) { const u = (g - v) / h; sum += Math.exp(-0.5 * u * u); } return sum / (s.samples.length * h * Math.sqrt(2 * Math.PI)); });
      const maxD = Math.max(...dens) || 1, vh = base - vTop;
      let d = `M ${x(grid[0]).toFixed(1)} ${base.toFixed(1)}`;
      grid.forEach((g, k) => { d += ` L ${x(g).toFixed(1)} ${(base - (dens[k] / maxD) * vh).toFixed(1)}`; });
      d += ` L ${x(grid[grid.length - 1]).toFixed(1)} ${base.toFixed(1)} Z`;
      parts.push(`<path class="dviolin" d="${d}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-opacity="0.7" />`);
      const by = base + 8, hh = 5;
      parts.push(`<rect class="dbox" x="${x(st.q25).toFixed(1)}" y="${by - hh}" width="${Math.max(1, x(st.q75) - x(st.q25)).toFixed(1)}" height="${2 * hh}" fill="${color}" fill-opacity="0.14" stroke="${color}" data-v="1" data-label="${esc(`${s.name} · IQR ${fmt(st.q25)}–${fmt(st.q75)} ms`)}" />`);
      parts.push(`<line x1="${x(st.p50).toFixed(1)}" y1="${by - hh}" x2="${x(st.p50).toFixed(1)}" y2="${by + hh}" stroke="${color}" stroke-width="2.5" data-v="1" data-label="${esc(`${s.name} · median ${fmt(st.p50)} ms${s.ci ? ` · 95% CI ${fmt(s.ci[0])}–${fmt(s.ci[1])}` : ""}`)}" />`);
      const py = base + 24, band = 8;
      s.samples.forEach((v, k) => parts.push(pt(x(v), py + jitter(k) * band, 2.4, color, `${s.name} · run #${k} · ${fmt(v)} ms`)));
    }
  });
  parts.push("</svg>");
  return parts.join("");
}

const EXP_CAPTIONS = {
  strip: "Every individual run as a dot (jittered so none overlap). Thick line = median. Nothing summarized away.",
  raincloud: "Density curve + IQR box + every raw run below. The long right tail is the worst-case click.",
  box: "Box = middle 50% (IQR), thick line = median, diamond = mean, whiskers to min/max.",
};

function drawExpDist() {
  const el = document.getElementById("exp-chart");
  if (!el) return;
  if (!SERIES.length) { el.innerHTML = '<p class="muted">No raw samples found for these variants.</p>'; return; }
  el.innerHTML = renderExpRows(expFmt);
  const cap = document.getElementById("exp-dist-cap");
  if (cap) cap.textContent = EXP_CAPTIONS[expFmt] || "";
}

function wireExpDist() {
  const bar = document.getElementById("exp-dist-toolbar");
  if (bar) bar.addEventListener("click", (ev) => {
    const b = ev.target.closest(".seg-btn");
    if (!b) return;
    expFmt = b.dataset.fmt;
    bar.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("is-active", x === b));
    drawExpDist();
  });
  const wrap = document.getElementById("exp-chart"), tip = document.getElementById("exp-dist-tip");
  if (wrap && tip) {
    wrap.addEventListener("mousemove", (ev) => {
      const t = ev.target.closest("[data-v]");
      if (!t) { tip.hidden = true; return; }
      tip.hidden = false;
      tip.textContent = t.getAttribute("data-label");
      const r = wrap.getBoundingClientRect();
      tip.style.left = Math.min(ev.clientX - r.left + 14, r.width - 220) + "px";
      tip.style.top = ev.clientY - r.top + 14 + "px";
    });
    wrap.addEventListener("mouseleave", () => { tip.hidden = true; });
  }
}

// ===========================================================================
//  Write-up
// ===========================================================================
function renderDetail(e) {
  const o = e.outcome || {};
  const pm = e.primary_metric || "p50_ms";
  const created = e.created ? new Date(e.created).toLocaleDateString() : "";
  const updated = e.updated ? new Date(e.updated).toLocaleString() : "";

  const rows = (e.variants || []).map((v) => {
    const m = v.metrics, color = VAR_COLOR[v.key] || meta(v.approach).color, isWin = o.winner === v.key;
    if (!m) {
      return `<tr><td><span class="dot" style="background:${color}"></span>${esc(v.name)}</td>
        <td>${esc(v.approach)} · ${esc(v.lang)}</td><td class="num muted" colspan="6">not run</td></tr>`;
    }
    return `<tr class="${isWin ? "win-row" : ""}">
      <td><span class="dot" style="background:${color}"></span>${esc(v.name)}${isWin ? ' <span class="win-badge">🏆</span>' : ""}</td>
      <td>${esc(v.approach)} · ${esc(v.lang)}</td>
      <td class="num">${m.n}</td><td class="num">${fmt(m.min_ms)}</td><td class="num">${fmt(m.p50_ms)}</td>
      <td class="num">${fmt(m.p95_ms)}</td><td class="num">${fmt(m.max_ms)}</td><td class="num">${fmt(m.mean_ms)}</td>
    </tr>`;
  }).join("");

  const banner = o.winner_name
    ? `<div class="exp-result-banner">
         <span class="win-badge">🏆 Winner</span>
         <span class="big">${esc(o.winner_name)}</span>
         <span class="muted">${fmt(o.winner_value)} ms ${esc(pm.replace("_ms", ""))}${o.delta_pct != null ? ` · ${o.delta_pct > 0 ? "+" : ""}${o.delta_pct}% vs ${esc(o.control_key || "control")}` : ""}</span>
       </div>`
    : `<p class="muted">Not run yet — <code>experiment.py run --id ${esc(e.id)}</code>.</p>`;

  return `
    <a class="exp-back" href="/#experiments">← All experiments</a>
    <div class="exp-head">
      <span class="exp-status exp-status--${esc(e.status)}">${esc(e.status)}</span>
      <span class="exp-id">#${esc(e.id)}</span>
    </div>
    <h1>${esc(e.title)}</h1>
    <p class="exp-dates">created ${created}${updated ? ` · updated ${updated}` : ""} · primary metric: ${esc(pm)}</p>

    <div class="exp-callout"><span class="k">Hypothesis</span>${esc(e.hypothesis) || "—"}</div>
    ${e.method ? `<section class="exp-section"><h2>What I did</h2><p>${esc(e.method)}</p></section>` : ""}

    <section class="exp-section">
      <h2>Every run — ${(e.variants || []).length} variants</h2>
      <div class="dist-toolbar" id="exp-dist-toolbar" role="tablist" aria-label="Chart format">
        <button class="seg-btn is-active" data-fmt="strip">Every run</button>
        <button class="seg-btn" data-fmt="raincloud">Raincloud</button>
        <button class="seg-btn" data-fmt="box">Box</button>
      </div>
      <div class="dist-wrap">
        <div id="exp-chart" class="chart dist-chart"></div>
        <div id="exp-dist-tip" class="dist-tip" hidden></div>
      </div>
      <p class="axis-note muted" id="exp-dist-cap"></p>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Variant</th><th>Setup</th><th class="num">n</th><th class="num">min</th>
            <th class="num">p50</th><th class="num">p95</th><th class="num">max</th><th class="num">mean</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <p class="axis-note muted">All figures in milliseconds · release→hit on the mock's single monotonic clock.</p>
      </div>
    </section>

    <section class="exp-section"><h2>Outcome</h2>${banner}</section>
    ${e.conclusion ? `<section class="exp-section"><h2>Conclusion</h2><p>${esc(e.conclusion)}</p></section>` : ""}
    ${e.decision ? `<div class="exp-callout exp-callout--decision"><span class="k">Decision</span>${esc(e.decision)}</div>` : ""}
  `;
}

(async function main() {
  const id = new URLSearchParams(location.search).get("id");
  const el = document.getElementById("exp");

  const [expData, research] = await Promise.all([
    fetch("/experiments.json", { headers: { accept: "application/json" } }).then((r) => r.ok ? r.json() : null).catch(() => null),
    fetch("/research.json", { headers: { accept: "application/json" } }).then((r) => r.ok ? r.json() : null).catch(() => null),
  ]);

  if (research && research.arms) research.arms.forEach((a) => { ARM_SAMPLES[`${a.approach}|${a.lang}`] = a; });

  const e = expData && (expData.experiments || []).find((x) => String(x.id) === String(id));
  if (!e) {
    el.innerHTML = '<a class="exp-back" href="/#experiments">← All experiments</a><p class="muted">Experiment not found.</p>';
    return;
  }
  (e.variants || []).forEach((v, i) => { VAR_COLOR[v.key] = PALETTE[i % PALETTE.length]; });

  document.title = `${e.title} — PastaPass experiment`;
  el.innerHTML = renderDetail(e);
  SERIES = buildSeries(e.variants || []);
  drawExpDist();
  wireExpDist();
})();
