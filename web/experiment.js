// Detail page for one tracked experiment. Reads ?id=… , fetches /experiments.json,
// and renders the full write-up: hypothesis, method, variant comparison, outcome.

const APPROACH = {
  "browser-observer": { tag: "A", name: "Browser observer", color: "#6ea8fe" },
  "http-direct":      { tag: "B", name: "HTTP-direct",      color: "#f4c95d" },
  "browser-hybrid":   { tag: "C", name: "Hybrid",           color: "#e0483a" },
};
const meta = (k) => APPROACH[k] || { tag: "?", name: k, color: "#9aa3b2" };
const fmt = (ms) => (ms < 1 ? ms.toFixed(3) : ms < 10 ? ms.toFixed(2) : ms.toFixed(1));
const esc = (s) => String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function renderVariantChart(variants) {
  const el = document.getElementById("exp-chart");
  if (!el) return;
  const vs = variants.filter((v) => v.metrics);
  if (!vs.length) { el.innerHTML = ""; return; }

  const W = 820, L = 214, R = 64, T = 14, rowH = 46;
  const H = T + vs.length * rowH + 34;
  const plotW = W - L - R;
  const hi = Math.max(...vs.map((v) => v.metrics.p95_ms)) * 1.15;
  const x = (ms) => L + (ms / hi) * plotW;

  const parts = [`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">`];
  const axisY = T + vs.length * rowH + 6;
  const step = hi <= 2 ? 0.5 : hi <= 5 ? 1 : 2;
  for (let t = 0; t <= hi + 1e-9; t += step) {
    const gx = x(t).toFixed(1);
    parts.push(`<line class="grid-line" x1="${gx}" y1="${T}" x2="${gx}" y2="${axisY}" />`);
    parts.push(`<text class="grid-label" x="${gx}" y="${axisY + 15}" text-anchor="middle">${t}</text>`);
  }
  parts.push(`<text class="grid-label" x="0" y="${axisY + 15}">milliseconds</text>`);

  vs.forEach((v, i) => {
    const cy = T + i * rowH + rowH / 2;
    const m = meta(v.approach);
    const xp50 = x(v.metrics.p50_ms), xp95 = x(v.metrics.p95_ms);
    parts.push(`<text class="row-label" x="0" y="${cy - 2}">${esc(v.name)}</text>`);
    parts.push(`<text class="row-lang" x="0" y="${cy + 13}">${esc(v.approach)} · ${esc(v.lang)} · n=${v.metrics.n}</text>`);
    parts.push(`<line class="lolli-line" x1="${xp50.toFixed(1)}" y1="${cy}" x2="${xp95.toFixed(1)}" y2="${cy}" stroke="${m.color}" />`);
    parts.push(`<line class="lolli-p95" x1="${xp95.toFixed(1)}" y1="${cy - 6}" x2="${xp95.toFixed(1)}" y2="${cy + 6}" stroke="${m.color}" />`);
    parts.push(`<circle cx="${xp50.toFixed(1)}" cy="${cy}" r="6" fill="${m.color}" />`);
    parts.push(`<text class="value-label" x="${xp50.toFixed(1)}" y="${cy - 11}" text-anchor="middle" fill="${m.color}">${fmt(v.metrics.p50_ms)}</text>`);
  });
  parts.push("</svg>");
  el.innerHTML = parts.join("");
}

function renderDetail(e) {
  const o = e.outcome || {};
  const pm = e.primary_metric || "p50_ms";
  const created = e.created ? new Date(e.created).toLocaleDateString() : "";
  const updated = e.updated ? new Date(e.updated).toLocaleString() : "";

  const rows = (e.variants || []).map((v) => {
    const m = v.metrics, am = meta(v.approach), isWin = o.winner === v.key;
    if (!m) {
      return `<tr><td><span class="dot" style="background:${am.color}"></span>${esc(v.name)}</td>
        <td>${esc(v.approach)} · ${esc(v.lang)}</td><td class="num muted" colspan="6">not run</td></tr>`;
    }
    return `<tr class="${isWin ? "win-row" : ""}">
      <td><span class="dot" style="background:${am.color}"></span>${esc(v.name)}${isWin ? ' <span class="win-badge">🏆</span>' : ""}</td>
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
      <h2>Variants &amp; measurements</h2>
      <div id="exp-chart" class="chart"></div>
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
  let data = null;
  try {
    const r = await fetch("/experiments.json", { headers: { accept: "application/json" } });
    if (r.ok) data = await r.json();
  } catch (_) { /* fall through */ }

  const e = data && (data.experiments || []).find((x) => String(x.id) === String(id));
  if (!e) {
    el.innerHTML = '<a class="exp-back" href="/#experiments">← All experiments</a><p class="muted">Experiment not found.</p>';
    return;
  }
  document.title = `${e.title} — PastaPass experiment`;
  el.innerHTML = renderDetail(e);
  renderVariantChart(e.variants || []);
})();
