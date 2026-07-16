// Shared plain-English glossary — one source of truth for every page.
// Loaded (as a classic script) BEFORE research.js / experiment.js, so GLOSS, gl,
// glossify and wireGloss are available to them. Hover / keyboard-focus / tap any
// element with data-gloss="key" to see its definition.
const GLOSS = {
  ci: "95% confidence interval — repeat the experiment and the true median lands in this range about 95% of the time. Narrower = more certain.",
  median: "The middle value: half the runs are faster, half slower. Sturdier than the average when there are slow outliers.",
  mean: "The plain average of every run — dragged upward by slow outliers, unlike the median.",
  std: "Standard deviation: how far the runs spread around the average. Bigger = less consistent.",
  pctile: "An Nth-percentile latency: N% of runs came in at least this fast. p95 ≈ a realistic worst case.",
  iqr: "Interquartile range: the spread of the middle 50% of runs (25th→75th percentile), ignoring the extremes.",
  cv: "Coefficient of variation (std ÷ mean): spread relative to the level, so a fast arm and a slow arm can be compared for consistency.",
  n: "Number of runs (trials) this arm was measured over — more runs give tighter estimates.",
  min: "The fastest single run — the best case, not what you'll typically get.",
  max: "The slowest single run — the worst case seen in this batch.",
  delta: "Change in the median versus the baseline arm, as a percent. Negative means faster.",
  mwu: "Mann–Whitney U test: asks whether two sets of runs are genuinely different, without assuming a bell curve. U is its rank-based score.",
  p: "p-value: the odds of seeing a gap this big if the two arms were actually identical. Under 0.05 means it is probably not a fluke.",
  cliffs: "Cliff's delta: how big the gap is, from 0 (identical) to ±1 (every run of one beats the other). The word labels its size: negligible, small, medium, large.",
  verdict: "‘Supported’ = the faster arm wins by a margin unlikely to be chance (p < 0.05).",
  bootstrap: "Bootstrap: re-draw the runs at random thousands of times to see how much the median could wobble — that wobble becomes the confidence interval.",
  skew: "Right-skewed: most runs bunch up low with a long tail of slow ones, so the average sits above the typical run.",
  nonparam: "Nonparametric: makes no assumption that the data follows a bell curve — latency doesn't.",
  monoclock: "One always-forward counter on the mock server stamps both the release and the hit, so there is no clock-sync error between machines.",
  releasehit: "Release→hit: the time from the server making the button live to the buy request landing — both stamped on that one clock.",
  dist: "Distribution: the full spread of every run, not just one summary number.",
  loopback: "Loopback: bot and mock server run on the same machine (127.0.0.1), so there's no real network — it isolates pure code/strategy overhead. On a live target the network round-trip would dominate.",
};

// wrap a term so it shows its glossary tooltip on hover/focus/tap
const gl = (key, text) => `<span class="gloss" data-gloss="${key}" tabindex="0">${text}</span>`;

// auto-wrap known jargon phrases inside a run of (already-escaped) prose. Single
// left-to-right pass, so inserted markup is never re-scanned.
const GLOSS_PHRASE_KEY = {
  "monotonic clock": "monoclock",
  "release→hit": "releasehit",
  "release->hit": "releasehit",
  "loopback": "loopback",
};
function glossify(html) {
  return html.replace(/monotonic clock|release→hit|release->hit|loopback/gi, (m) =>
    gl(GLOSS_PHRASE_KEY[m.toLowerCase()] || "", m));
}

// ===========================================================================
//  Tooltip engine — delegated hover / keyboard-focus / tap on [data-gloss]
// ===========================================================================
function wireGloss() {
  let tip = document.getElementById("gloss-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "gloss-tip";
    tip.className = "gloss-tip";
    tip.hidden = true;
    document.body.appendChild(tip);
  }
  let current = null;
  const show = (el) => {
    const txt = GLOSS[el.dataset.gloss];
    if (!txt) return;
    current = el;
    tip.textContent = txt;
    tip.hidden = false;
    // measure off-screen, then place below the term, flipping/clamping to stay visible
    tip.style.left = "-9999px"; tip.style.top = "0px";
    const r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = Math.max(12, Math.min(r.left, window.innerWidth - tw - 12));
    let top = r.bottom + 8;
    if (top + th > window.innerHeight - 12) top = r.top - th - 8; // flip above if no room below
    tip.style.left = left + "px";
    tip.style.top = Math.max(8, top) + "px";
  };
  const hide = () => { tip.hidden = true; current = null; };
  const near = (e) => e.target.closest("[data-gloss]");
  document.addEventListener("mouseover", (e) => { const el = near(e); if (el) show(el); });
  document.addEventListener("mouseout", (e) => { if (near(e) === current && current) hide(); });
  document.addEventListener("focusin", (e) => { const el = near(e); if (el) show(el); });
  document.addEventListener("focusout", hide);
  // capture so tapping a term inside a card link shows the tip instead of navigating
  document.addEventListener("click", (e) => {
    const el = near(e);
    if (el) { e.preventDefault(); e.stopPropagation(); show(el); } else hide();
  }, true);
  window.addEventListener("scroll", hide, true);
}
