#!/usr/bin/env python3
"""Build web/research.json — the data behind the Research page.

Unlike build_dashboard_data.py (which keeps only summary stats), this retains the
RAW per-trial samples for every arm so the front end can draw real distributions,
and it runs the nonparametric stats layer (bootstrap median CI, Mann-Whitney U,
Cliff's delta) so every hypothesis gets a verdict with a significance test.

    ./run-all.sh                                  # produce benchmark/results/*.csv
    python3 benchmark/build_research_data.py --label "loopback sweep"
    git add web/research.json && git commit && git push   # Vercel auto-redeploys
"""
import argparse
import csv
import glob
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import stats  # noqa: E402  (local module, path-injected above)

HERE = os.path.dirname(__file__)
RESULTS_DIR = os.path.join(HERE, "results")
EXP_DIR = os.path.join(HERE, "..", "experiments")
OUT = os.path.join(HERE, "..", "web", "research.json")

R4 = lambda x: round(float(x), 4)


def load_samples():
    """Return {(approach, lang): [ms, ...]} from every results CSV."""
    out = {}
    for fp in sorted(glob.glob(os.path.join(RESULTS_DIR, "*.csv"))):
        with open(fp) as f:
            rows = list(csv.DictReader(f))
        ms = [int(r["server_latency_ns"]) / 1e6 for r in rows if r.get("server_latency_ns")]
        if not ms:
            continue
        key = (rows[0]["approach"], rows[0].get("lang", "?"))
        out[key] = ms
    return out


def rounded_stats(ms):
    s = {k: (round(v, 4) if isinstance(v, float) else v) for k, v in stats.summary(ms).items()}
    lo, hi = stats.bootstrap_ci_median(ms)
    s_ci = [R4(lo), R4(hi)]
    return s, s_ci


def build_arms(samples):
    arms = []
    for (approach, lang), ms in samples.items():
        s, ci = rounded_stats(ms)
        arms.append({
            "approach": approach,
            "lang": lang,
            "n": len(ms),
            "samples": [R4(x) for x in ms],
            "stats": s,
            "ci_median": ci,
        })
    arms.sort(key=lambda a: a["stats"]["p50"])
    return arms


def variant_block(v, samples):
    """One variant of an experiment, enriched with raw samples + stats."""
    ms = samples.get((v["approach"], v.get("lang", "?")))
    block = {
        "key": v["key"],
        "name": v["name"],
        "approach": v["approach"],
        "lang": v.get("lang", "?"),
    }
    if ms:
        s, ci = rounded_stats(ms)
        block.update({"n": len(ms), "samples": [R4(x) for x in ms], "stats": s, "ci_median": ci})
    return block, ms


def build_experiments(samples):
    exps = []
    for fp in sorted(glob.glob(os.path.join(EXP_DIR, "*.json"))):
        with open(fp) as f:
            e = json.load(f)
        outcome = e.get("outcome", {})
        by_key = {v["key"]: v for v in e.get("variants", [])}
        control_key = outcome.get("control_key", "control")
        winner_key = outcome.get("winner")

        control_v = by_key.get(control_key)
        winner_v = by_key.get(winner_key)
        control_block = winner_block = test = None
        if control_v and winner_v and control_v is not winner_v:
            control_block, c_ms = variant_block(control_v, samples)
            winner_block, w_ms = variant_block(winner_v, samples)
            if c_ms and w_ms:
                mwu = stats.mann_whitney_u(c_ms, w_ms)
                cd = stats.cliffs_delta(c_ms, w_ms)
                test = {
                    "control_key": control_key,
                    "winner_key": winner_key,
                    "u": round(mwu["U"], 1),
                    "z": round(mwu["z"], 3),
                    "p": mwu["p"],
                    "significant": mwu["p"] < 0.05,
                    "cliffs_delta": round(cd["delta"], 3),
                    "cliffs_label": cd["label"],
                    "delta_ms": outcome.get("delta_ms"),
                    "delta_pct": outcome.get("delta_pct"),
                }

        exps.append({
            "id": e["id"],
            "title": e["title"],
            "status": e.get("status", ""),
            "hypothesis": e.get("hypothesis", ""),
            "method": e.get("method", ""),
            "primary_metric": e.get("primary_metric", "p50_ms"),
            "conclusion": e.get("conclusion", ""),
            "decision": e.get("decision", ""),
            "outcome": outcome,
            "control": control_block,
            "winner": winner_block,
            "test": test,
        })
    return exps


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", default="", help="optional label for this snapshot")
    ap.add_argument("--iso", default=None, help="ISO timestamp (default: now)")
    args = ap.parse_args()

    samples = load_samples()
    if not samples:
        print("No CSVs in benchmark/results/ — run ./run-all.sh first.")
        return

    arms = build_arms(samples)
    experiments = build_experiments(samples)
    now_iso = args.iso or time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())

    out = {
        "updated_at": now_iso,
        "label": args.label,
        "source": "benchmark/results/*.csv",
        "method_note": ("Percentiles by linear interpolation (type-7). Median CI by "
                        "seeded nonparametric bootstrap (2000 resamples). Between-arm test: "
                        "Mann-Whitney U (two-sided, tie + continuity corrected); effect size: "
                        "Cliff's delta. No normality assumed."),
        "total_arms": len(arms),
        "total_measurements": sum(a["n"] for a in arms),
        "arms": arms,
        "experiments": experiments,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=2)

    print(f"Wrote {os.path.relpath(OUT)}: {len(arms)} arms, "
          f"{out['total_measurements']} measurements, {len(experiments)} experiments.")
    for a in arms:
        ci = a["ci_median"]
        print(f"  {a['approach']:<16} {a['lang']:<7} n={a['n']:<3} "
              f"p50={a['stats']['p50']:.3f}  95%CI[{ci[0]:.3f},{ci[1]:.3f}]  "
              f"p95={a['stats']['p95']:.3f}")


if __name__ == "__main__":
    main()
