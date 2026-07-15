// Research page — reads /research.json (raw per-trial samples + nonparametric stats)
// and renders: hypothesis verdict cards, a per-arm distribution explorer with four
// toggleable formats (raincloud / box / strip / ECDF) and hover-to-inspect, and a
// full statistics table. Vanilla JS building SVG strings, same idiom as app.js.

const APPROACH = {
  "browser-observer": { tag: "A", name: "Browser observer" },
  "http-direct":      { tag: "B", name: "HTTP-direct" },
  "browser-hybrid":   { tag: "C", name: "Hybrid" },
  "conn-warm":        { tag: "W", name: "Warm socket" },
  "conn-cold":        { tag: "K", name: "Cold connect" },
  "fire-proactive":   { tag: "P", name: "Proactive" },
  "fire-reactive":    { tag: "R", name: "Reactive" },
};
// Distinct per-arm palette (approach colors collide across langs; the explorer needs
// every arm separable, especially when ECDF overlays them all).
const PALETTE = ["#f4c95d", "#7ee0a8", "#6ea8fe", "#c792ea", "#f0a24b", "#4fd1c5", "#f78fb3", "#e0483a", "#9aa3b2"];

const amMeta = (k) => APPROACH[k] || { tag: "?", name: k };
const fmt = (ms) => (ms == null ? "—" : ms < 1 ? ms.toFixed(3) : ms < 10 ? ms.toFixed(2) : ms.toFixed(1));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const armKey = (a) => `${a.approach}|${a.lang}`;
const armLabel = (a) => { const m = amMeta(a.approach); return `${m.tag} · ${m.name} [${a.lang}]`; };
const pfmt = (p) => (p < 1e-4 ? p.toExponential(1) : p < 0.001 ? p.toFixed(5) : p.toFixed(4));

let ARM_COLOR = {}; // key -> color, assigned in p50 order

// --- log-scale helpers (shared idiom with app.js) --------------------------
function logTicks(lo, hi) {
  const ticks = [];
  for (let p = Math.floor(Math.log10(lo)); p <= Math.ceil(Math.log10(hi)); p++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** p;
      if (v >= lo * 0.98 && v <= hi * 1.02) ticks.push(v);
    }
  }
  return ticks;
}
// deterministic jitter in [-1, 1] from an index (stable across re-renders)
const jitter = (i) => { const x = Math.sin(i * 12.9898 + 1.3) * 43758.5453; return 2 * (x - Math.floor(x)) - 1; };

// ===========================================================================
//  Hypotheses & verdicts
// ===========================================================================
function renderHypotheses(exps) {
  const el = document.getElementById("hypotheses");
  if (!exps || !exps.length) { el.innerHTML = '<p class="muted">No experiments yet.</p>'; return; }
  el.innerHTML = exps.map((e) => {
    const t = e.test, c = e.control, w = e.winner;
    let verdict = '<span class="hyp-flag hyp-flag--none">not run</span>';
    let stat = "";
    if (t && c && w) {
      const sig = t.significant;
      verdict = `<span class="hyp-flag ${sig ? "hyp-flag--yes" : "hyp-flag--no"}">${sig ? "✓ supported" : "✕ not significant"}</span>`;
      const cc = ARM_COLOR[armKey(c)], wc = ARM_COLOR[armKey(w)];
      stat = `
        <div class="hyp-face">
          <div class="hyp-arm">
            <span class="dot" style="background:${cc}"></span>${esc(c.name)}
            <span class="hyp-med">${fmt(c.stats.p50)}<span class="hyp-ci">CI ${fmt(c.ci_median[0])}–${fmt(c.ci_median[1])}</span></span>
          </div>
          <div class="hyp-vs">vs</div>
          <div class="hyp-arm hyp-arm--win">
            <span class="dot" style="background:${wc}"></span>${esc(w.name)} <span class="win-badge">🏆</span>
            <span class="hyp-med">${fmt(w.stats.p50)}<span class="hyp-ci">CI ${fmt(w.ci_median[0])}–${fmt(w.ci_median[1])}</span></span>
          </div>
        </div>
        <div class="hyp-stats">
          <span><b>Δ median</b> ${t.delta_pct > 0 ? "+" : ""}${t.delta_pct}%</span>
          <span><b>Mann–Whitney</b> U=${t.u}, p=${pfmt(t.p)}</span>
          <span><b>Cliff's δ</b> ${t.cliffs_delta} (${t.cliffs_label})</span>
        </div>`;
    }
    return `<a class="hyp-card" href="/experiment.html?id=${encodeURIComponent(e.id)}">
      <div class="hyp-top">
        <span class="exp-id">#${esc(e.id)}</span>
        <h3>${esc(e.title)}</h3>
        ${verdict}
      </div>
      <p class="hyp-text">${esc(e.hypothesis)}</p>
      ${stat}
      ${e.conclusion ? `<p class="hyp-concl">${esc(e.conclusion)}</p>` : ""}
      ${e.decision ? `<div class="hyp-decision"><span class="k">Decision</span>${esc(e.decision)}</div>` : ""}
    </a>`;
  }).join("");
}

// ===========================================================================
//  Distribution explorer
// ===========================================================================
const SVG_W = 940;
let ARMS = [];
let curFmt = "raincloud";

function scaleXFactory(L, plotW) {
  const allMin = Math.min(...ARMS.map((a) => a.stats.min));
  const allMax = Math.max(...ARMS.map((a) => a.stats.max));
  const lo = Math.max(1e-3, allMin * 0.82), hi = allMax * 1.12;
  const lgLo = Math.log10(lo), lgHi = Math.log10(hi);
  const x = (ms) => L + ((Math.log10(Math.max(ms, lo)) - lgLo) / (lgHi - lgLo)) * plotW;
  return { x, lo, hi };
}

function axisSvg(x, lo, hi, top, bottom, labelY) {
  let s = "";
  for (const t of logTicks(lo, hi)) {
    const gx = x(t).toFixed(1);
    s += `<line class="grid-line" x1="${gx}" y1="${top}" x2="${gx}" y2="${bottom}" />`;
    s += `<text class="grid-label" x="${gx}" y="${labelY}" text-anchor="middle">${fmt(t)}</text>`;
  }
  return s;
}

function pt(cx, cy, r, color, label) {
  return `<circle class="dpoint" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r}" fill="${color}" data-v="1" data-label="${esc(label)}" />`;
}

// ---- row-based formats (raincloud / box / strip) --------------------------
function renderRows(fmtName) {
  const L = 212, R = 26, T = 14;
  const rowH = fmtName === "raincloud" ? 66 : 44;
  const plotW = SVG_W - L - R;
  const H = T + ARMS.length * rowH + 42;
  const { x, lo, hi } = scaleXFactory(L, plotW);
  const axisY = T + ARMS.length * rowH + 8;

  const parts = [`<svg viewBox="0 0 ${SVG_W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">`];
  parts.push(axisSvg(x, lo, hi, T, axisY, axisY + 16));
  parts.push(`<text class="grid-label" x="0" y="${axisY + 16}" text-anchor="start">milliseconds · log scale</text>`);

  ARMS.forEach((a, i) => {
    const color = ARM_COLOR[armKey(a)];
    const rowTop = T + i * rowH;
    const s = a.stats;
    const lab = armLabel(a);
    // left label
    const ly = rowTop + rowH / 2;
    parts.push(`<text class="row-label" x="0" y="${(ly - 4).toFixed(1)}">${esc(lab)}</text>`);
    parts.push(`<text class="row-lang" x="0" y="${(ly + 12).toFixed(1)}">n=${a.n} · p50 ${fmt(s.p50)} ms</text>`);

    if (fmtName === "strip") {
      const cy = rowTop + rowH / 2, band = 12;
      a.samples.forEach((v, k) => parts.push(pt(x(v), cy + jitter(k) * band, 2.6, color, `${lab} · run #${k} · ${fmt(v)} ms`)));
      parts.push(`<line x1="${x(s.p50).toFixed(1)}" y1="${cy - 15}" x2="${x(s.p50).toFixed(1)}" y2="${cy + 15}" stroke="${color}" stroke-width="2" />`);
    } else if (fmtName === "box") {
      const cy = rowTop + rowH / 2, hh = 9;
      const xq1 = x(s.q25), xq3 = x(s.q75), xmed = x(s.p50), xmin = x(s.min), xmax = x(s.max), xmean = x(s.mean);
      // whiskers
      parts.push(`<line class="dwhisk" x1="${xmin.toFixed(1)}" y1="${cy}" x2="${xq1.toFixed(1)}" y2="${cy}" stroke="${color}" />`);
      parts.push(`<line class="dwhisk" x1="${xq3.toFixed(1)}" y1="${cy}" x2="${xmax.toFixed(1)}" y2="${cy}" stroke="${color}" />`);
      parts.push(`<line x1="${xmin.toFixed(1)}" y1="${cy - 5}" x2="${xmin.toFixed(1)}" y2="${cy + 5}" stroke="${color}" stroke-width="1.5" data-v="1" data-label="${esc(`${lab} · min ${fmt(s.min)} ms`)}" />`);
      parts.push(`<line x1="${xmax.toFixed(1)}" y1="${cy - 5}" x2="${xmax.toFixed(1)}" y2="${cy + 5}" stroke="${color}" stroke-width="1.5" data-v="1" data-label="${esc(`${lab} · max ${fmt(s.max)} ms`)}" />`);
      // IQR box
      parts.push(`<rect class="dbox" x="${xq1.toFixed(1)}" y="${cy - hh}" width="${Math.max(1, xq3 - xq1).toFixed(1)}" height="${2 * hh}" fill="${color}" fill-opacity="0.16" stroke="${color}" data-v="1" data-label="${esc(`${lab} · IQR ${fmt(s.q25)}–${fmt(s.q75)} ms`)}" />`);
      // median
      parts.push(`<line x1="${xmed.toFixed(1)}" y1="${cy - hh}" x2="${xmed.toFixed(1)}" y2="${cy + hh}" stroke="${color}" stroke-width="2.5" data-v="1" data-label="${esc(`${lab} · median ${fmt(s.p50)} ms`)}" />`);
      // mean diamond
      parts.push(`<path d="M ${xmean.toFixed(1)} ${cy - 4} l 4 4 l -4 4 l -4 -4 z" fill="#0d0f14" stroke="${color}" stroke-width="1.4" data-v="1" data-label="${esc(`${lab} · mean ${fmt(s.mean)} ms`)}" />`);
    } else { // raincloud
      const base = rowTop + 34;             // centerline for the cloud + box
      const violinTop = rowTop + 4;
      // KDE density hump (above base)
      const grid = [];
      const lgLo = Math.log10(lo), lgHi = Math.log10(hi), NG = 72;
      for (let g = 0; g < NG; g++) grid.push(10 ** (lgLo + (lgHi - lgLo) * (g / (NG - 1))));
      const h = Math.max(0.02, 1.06 * (s.std || 0.05) * Math.pow(a.n, -0.2));
      const dens = grid.map((g) => {
        let sum = 0;
        for (const v of a.samples) { const u = (g - v) / h; sum += Math.exp(-0.5 * u * u); }
        return sum / (a.n * h * Math.sqrt(2 * Math.PI));
      });
      const maxD = Math.max(...dens) || 1, vh = base - violinTop;
      let path = `M ${x(grid[0]).toFixed(1)} ${base.toFixed(1)}`;
      grid.forEach((g, k) => { path += ` L ${x(g).toFixed(1)} ${(base - (dens[k] / maxD) * vh).toFixed(1)}`; });
      path += ` L ${x(grid[grid.length - 1]).toFixed(1)} ${base.toFixed(1)} Z`;
      parts.push(`<path class="dviolin" d="${path}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-opacity="0.7" />`);
      // thin box just below base
      const by = base + 8, hh = 5;
      parts.push(`<rect class="dbox" x="${x(s.q25).toFixed(1)}" y="${by - hh}" width="${Math.max(1, x(s.q75) - x(s.q25)).toFixed(1)}" height="${2 * hh}" fill="${color}" fill-opacity="0.14" stroke="${color}" data-v="1" data-label="${esc(`${lab} · IQR ${fmt(s.q25)}–${fmt(s.q75)} ms`)}" />`);
      parts.push(`<line x1="${x(s.p50).toFixed(1)}" y1="${by - hh}" x2="${x(s.p50).toFixed(1)}" y2="${by + hh}" stroke="${color}" stroke-width="2.5" data-v="1" data-label="${esc(`${lab} · median ${fmt(s.p50)} ms · 95% CI ${fmt(a.ci_median[0])}–${fmt(a.ci_median[1])}`)}" />`);
      // rain (points) below
      const py = base + 22, band = 7;
      a.samples.forEach((v, k) => parts.push(pt(x(v), py + jitter(k) * band, 2.3, color, `${lab} · run #${k} · ${fmt(v)} ms`)));
    }
  });
  parts.push("</svg>");
  return parts.join("");
}

// ---- ECDF (overlay all arms) ----------------------------------------------
function renderEcdf() {
  const L = 58, R = 158, T = 14, plotH = 340;
  const plotW = SVG_W - L - R;
  const H = T + plotH + 44;
  const { x, lo, hi } = scaleXFactory(L, plotW);
  const y = (p) => T + (1 - p) * plotH;
  const axisY = T + plotH;

  const parts = [`<svg viewBox="0 0 ${SVG_W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif">`];
  // y gridlines
  for (const yv of [0, 0.25, 0.5, 0.75, 0.95, 1]) {
    const gy = y(yv).toFixed(1);
    parts.push(`<line class="grid-line" x1="${L}" y1="${gy}" x2="${L + plotW}" y2="${gy}" ${yv === 0.5 || yv === 0.95 ? 'stroke-dasharray="3 3"' : ""} />`);
    parts.push(`<text class="grid-label" x="${L - 8}" y="${(y(yv) + 3).toFixed(1)}" text-anchor="end">${yv === 0.95 ? "0.95" : yv}</text>`);
  }
  parts.push(axisSvg(x, lo, hi, T, axisY, axisY + 16));
  parts.push(`<text class="grid-label" x="0" y="${axisY + 16}" text-anchor="start">ms · log</text>`);
  parts.push(`<text class="grid-label" x="${L}" y="${T - 2}" text-anchor="start">cumulative fraction of runs ≤ x</text>`);

  ARMS.forEach((a, i) => {
    const color = ARM_COLOR[armKey(a)];
    const sorted = [...a.samples].sort((p, q) => p - q);
    const n = sorted.length;
    let d = `M ${x(sorted[0]).toFixed(1)} ${y(0).toFixed(1)}`;
    const dots = [];
    sorted.forEach((v, k) => {
      const cx = x(v), yPrev = (k) / n, yCur = (k + 1) / n;
      d += ` L ${cx.toFixed(1)} ${y(yPrev).toFixed(1)} L ${cx.toFixed(1)} ${y(yCur).toFixed(1)}`;
      dots.push(pt(cx, y(yCur), 2.1, color, `${armLabel(a)} · run ${fmt(v)} ms · ${Math.round(yCur * 100)}th pct`));
    });
    parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-opacity="0.9" />`);
    parts.push(dots.join(""));
    // legend
    const ly = T + 6 + i * 20;
    parts.push(`<rect x="${L + plotW + 16}" y="${ly}" width="11" height="11" rx="2" fill="${color}" />`);
    parts.push(`<text class="row-lang" x="${L + plotW + 32}" y="${ly + 10}">${esc(armLabel(a))}</text>`);
  });
  parts.push("</svg>");
  return parts.join("");
}

const CAPTIONS = {
  raincloud: "Density hump + IQR box + every raw run below. The long right tail is the story — that's your worst-case click.",
  box: "Box = IQR, thick line = median, diamond = mean, whiskers to min/max. Compact, but hides the point cloud.",
  strip: "Every single run as a dot, jittered vertically. Nothing hidden — you see clustering and outliers directly.",
  ecdf: "Cumulative curves: read any percentile off the y-axis. Leftmost curve wins; a steep rise = a tight, predictable arm.",
};

function drawDist() {
  const el = document.getElementById("dist-chart");
  el.innerHTML = curFmt === "ecdf" ? renderEcdf() : renderRows(curFmt);
  document.getElementById("dist-caption").textContent = CAPTIONS[curFmt] || "";
}

function wireToolbar() {
  const bar = document.getElementById("dist-toolbar");
  bar.addEventListener("click", (ev) => {
    const b = ev.target.closest(".seg-btn");
    if (!b) return;
    curFmt = b.dataset.fmt;
    bar.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("is-active", x === b));
    drawDist();
  });
  // hover-to-inspect (delegated; the container persists across re-renders)
  const wrap = document.getElementById("dist-chart");
  const tip = document.getElementById("dist-tip");
  wrap.addEventListener("mousemove", (ev) => {
    const target = ev.target.closest("[data-v]");
    if (!target) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.textContent = target.getAttribute("data-label");
    const r = wrap.getBoundingClientRect();
    tip.style.left = Math.min(ev.clientX - r.left + 14, r.width - 220) + "px";
    tip.style.top = ev.clientY - r.top + 14 + "px";
  });
  wrap.addEventListener("mouseleave", () => { tip.hidden = true; });
}

// ===========================================================================
//  Stats table
// ===========================================================================
function renderStatsTable(arms) {
  const tb = document.querySelector("#stats-table tbody");
  tb.innerHTML = arms.map((a) => {
    const s = a.stats, color = ARM_COLOR[armKey(a)];
    return `<tr>
      <td><span class="dot" style="background:${color}"></span>${esc(armLabel(a))}</td>
      <td class="num">${a.n}</td>
      <td class="num">${fmt(s.mean)}</td>
      <td class="num">${fmt(s.std)}</td>
      <td class="num">${fmt(s.p50)} <span class="muted">(${fmt(a.ci_median[0])}–${fmt(a.ci_median[1])})</span></td>
      <td class="num">${fmt(s.p90)}</td>
      <td class="num">${fmt(s.p95)}</td>
      <td class="num">${fmt(s.p99)}</td>
      <td class="num">${fmt(s.iqr)}</td>
      <td class="num">${s.cv.toFixed(2)}</td>
    </tr>`;
  }).join("");
}

// ===========================================================================
(async function main() {
  let data;
  try {
    const r = await fetch("/research.json", { headers: { accept: "application/json" } });
    data = await r.json();
  } catch (_) {
    document.getElementById("hypotheses").innerHTML = '<p class="muted">Could not load research.json — run <code>python3 benchmark/build_research_data.py</code>.</p>';
    return;
  }
  ARMS = data.arms || [];
  ARMS.forEach((a, i) => { ARM_COLOR[armKey(a)] = PALETTE[i % PALETTE.length]; });

  const meta = document.getElementById("rsrch-meta");
  if (meta) {
    const when = data.updated_at ? new Date(data.updated_at).toLocaleString() : "";
    meta.textContent = `${data.total_arms} arms · ${data.total_measurements} measurements` +
      (data.label ? ` · "${data.label}"` : "") + (when ? ` · updated ${when}` : "");
  }
  const mn = document.getElementById("method-note");
  if (mn && data.method_note) mn.textContent = data.method_note;

  renderHypotheses(data.experiments || []);
  renderStatsTable(ARMS);
  wireToolbar();
  drawDist();
})();
