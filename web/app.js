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
  // Try the live API first; fall back to bundled sample data.
  try {
    const r = await fetch("/api/results", { headers: { accept: "application/json" } });
    if (r.ok) {
      const data = await r.json();
      if (data.groups && data.groups.length) return { data, sample: false };
    }
  } catch (_) { /* offline / static preview — fall through */ }

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

(async function main() {
  const { data, sample } = await load();
  const groups = data.groups || [];
  if (sample) document.getElementById("sample-ribbon").hidden = false;
  renderHeadline(groups);
  renderChart(groups);
  renderTable(groups);
  renderMeta(data, sample);
})();
