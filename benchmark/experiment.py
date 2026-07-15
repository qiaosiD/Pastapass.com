#!/usr/bin/env python3
"""
Experiment tracker for the PastaPass A/B benchmark.

An "experiment" is a professional record of one A/B test: a hypothesis, the method
(what you did), the variants (arms) you compared, the measured outcome, and your
conclusion + decision. Each is a versioned JSON in experiments/, rendered on the site
as its own page.

Lifecycle:
    # 1. define it
    python3 benchmark/experiment.py new \
        --title "Rust vs Python — the HTTP-direct floor" \
        --hypothesis "A compiled language posts a lower firing floor than Python." \
        --metric p50_ms

    # 2. add the arms you're comparing
    python3 benchmark/experiment.py add-variant --id 001 --key control   --name "Python (baseline)" --approach http-direct --lang python --trials 30
    python3 benchmark/experiment.py add-variant --id 001 --key treatment --name "Rust (std-only)"   --approach http-direct --lang rust   --trials 30

    # 3. run the arms (executes the bots, attaches metrics, computes the winner)
    python3 benchmark/experiment.py run --id 001

    # 4. record what you concluded
    python3 benchmark/experiment.py conclude --id 001 \
        --conclusion "Rust wins the floor, but both cluster within ~1 ms — approach dominates language." \
        --decision  "Publish Rust as the floor; keep Python for iteration."

    # 5. compile for the site, then commit (yours) → Vercel redeploys
    python3 benchmark/experiment.py build
    git add web/experiments.json experiments/ && git commit && git push
"""
import argparse
import csv
import glob
import json
import os
import re
import statistics
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EXP_DIR = os.path.join(ROOT, "experiments")
RESULTS_DIR = os.path.join(ROOT, "benchmark", "results")
WEB_JSON = os.path.join(ROOT, "web", "experiments.json")
MOCK = "http://127.0.0.1:3000"

# (approach, lang) -> argv (relative to ROOT). Rust is compiled on demand below.
BOTS = {
    ("http-direct", "python"): ["python3", "bots/python/approach_b_http.py"],
    ("http-direct", "node"):   ["node", "bots/node/approach_b_http.mjs"],
    ("browser-observer", "python"): ["python3", "bots/python/approach_a_browser.py"],
    ("browser-hybrid", "python"):   ["python3", "bots/python/approach_c_hybrid.py"],
    # experiment variants (each self-labels its CSV via --approach/--lang):
    ("conn-warm", "python"): ["python3", "bots/python/approach_b_http.py", "--mode", "warm", "--approach", "conn-warm", "--lang", "python"],
    ("conn-cold", "python"): ["python3", "bots/python/approach_b_http.py", "--mode", "cold", "--approach", "conn-cold", "--lang", "python"],
    ("fire-reactive", "python"):  ["python3", "bots/python/approach_fire.py", "--mode", "reactive",  "--approach", "fire-reactive",  "--lang", "python"],
    ("fire-proactive", "python"): ["python3", "bots/python/approach_fire.py", "--mode", "proactive", "--approach", "fire-proactive", "--lang", "python"],
}
METRIC_KEYS = ["min_ms", "p50_ms", "p95_ms", "max_ms", "mean_ms"]


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:48] or "experiment"


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


def pctile(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))]


def exp_path(eid, slug=None):
    if slug:
        return os.path.join(EXP_DIR, f"{eid}-{slug}.json")
    hits = glob.glob(os.path.join(EXP_DIR, f"{eid}-*.json"))
    if not hits:
        sys.exit(f"no experiment with id {eid} (run `experiment.py list`)")
    return hits[0]


def load_exp(eid):
    with open(exp_path(eid)) as f:
        return json.load(f)


def save_exp(exp):
    os.makedirs(EXP_DIR, exist_ok=True)
    with open(exp_path(exp["id"], exp["slug"]), "w") as f:
        json.dump(exp, f, indent=2)


def next_id():
    ids = [int(os.path.basename(p).split("-")[0]) for p in glob.glob(os.path.join(EXP_DIR, "*.json"))]
    return f"{(max(ids) + 1) if ids else 1:03d}"


def metrics_from_csv(approach, lang):
    fp = os.path.join(RESULTS_DIR, f"{approach}_{lang}.csv")
    if not os.path.exists(fp):
        return None
    with open(fp) as f:
        rows = list(csv.DictReader(f))
    ms = [int(r["server_latency_ns"]) / 1e6 for r in rows if r.get("server_latency_ns")]
    if not ms:
        return None
    return {
        "n": len(ms),
        "min_ms": round(min(ms), 4), "p50_ms": round(statistics.median(ms), 4),
        "p95_ms": round(pctile(ms, 0.95), 4), "max_ms": round(max(ms), 4),
        "mean_ms": round(statistics.mean(ms), 4),
    }


def ensure_mock():
    try:
        urllib.request.urlopen(MOCK + "/health", timeout=2)
        return
    except Exception:
        pass
    print("[mock] starting server on :3000 …")
    subprocess.Popen(["node", "mock-site/server.js"], cwd=ROOT,
                     env={**os.environ, "PORT": "3000"},
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(50):
        try:
            urllib.request.urlopen(MOCK + "/health", timeout=2)
            print("[mock] up")
            return
        except Exception:
            time.sleep(0.2)
    sys.exit("[mock] server did not come up — start it with `node mock-site/server.js`")


def run_variant(v):
    approach, lang, trials = v["approach"], v["lang"], v.get("trials", 25)
    if (approach, lang) in BOTS:
        cmd = list(BOTS[(approach, lang)]) + ["--trials", str(trials)]
        if approach == "http-direct":
            cmd += ["--lang", lang]
    elif approach == "http-direct" and lang == "rust":
        rustc = os.path.expanduser("~/.cargo/bin/rustc")
        rustc = rustc if os.path.exists(rustc) else "rustc"
        binp = "/tmp/pp_rustbot"
        subprocess.run([rustc, "-O", "bots/rust/approach_b_http.rs", "-o", binp], cwd=ROOT, check=True)
        cmd = [binp, "--trials", str(trials), "--lang", "rust"]
    else:
        sys.exit(f"no bot registered for ({approach}, {lang})")
    print(f"  · {v['key']}: {v['name']}  ({approach} / {lang}, {trials} trials)")
    subprocess.run(cmd, cwd=ROOT, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return metrics_from_csv(approach, lang)


def compute_outcome(exp):
    pm = exp.get("primary_metric", "p50_ms")
    scored = [v for v in exp["variants"] if v.get("metrics")]
    if len(scored) < 1:
        return None
    control = next((v for v in exp["variants"] if v["key"] == "control"), exp["variants"][0])
    winner = min(scored, key=lambda v: v["metrics"][pm])
    cv = control.get("metrics", {}).get(pm)
    wv = winner["metrics"][pm]
    out = {"primary_metric": pm, "winner": winner["key"], "winner_name": winner["name"], "winner_value": wv}
    if cv is not None:
        out.update({
            "control_key": control["key"], "control_value": cv,
            "delta_ms": round(wv - cv, 4),
            "delta_pct": round((wv - cv) / cv * 100, 1) if cv else None,
        })
    return out


# ---- subcommands -----------------------------------------------------------
def cmd_new(a):
    eid = next_id()
    exp = {
        "id": eid, "slug": slugify(a.title), "title": a.title,
        "status": "planned", "created": now_iso(), "updated": now_iso(),
        "hypothesis": a.hypothesis, "primary_metric": a.metric,
        "method": a.method or "", "variants": [],
        "outcome": None, "conclusion": "", "decision": "",
    }
    save_exp(exp)
    print(f"created experiment {eid}: {a.title}\n  {exp_path(eid, exp['slug'])}")
    print("  next: add-variant, then run, then conclude")


def cmd_add_variant(a):
    exp = load_exp(a.id)
    if any(v["key"] == a.key for v in exp["variants"]):
        sys.exit(f"variant key '{a.key}' already exists in {a.id}")
    exp["variants"].append({
        "key": a.key, "name": a.name, "approach": a.approach,
        "lang": a.lang, "trials": a.trials, "metrics": None,
    })
    exp["updated"] = now_iso()
    save_exp(exp)
    print(f"added variant '{a.key}' ({a.name}) to {a.id}")


def cmd_run(a):
    exp = load_exp(a.id)
    if not exp["variants"]:
        sys.exit("no variants — add some with `add-variant` first")
    ensure_mock()
    exp["status"] = "running"
    print(f"running experiment {exp['id']}: {exp['title']}")
    for v in exp["variants"]:
        v["metrics"] = run_variant(v)
    exp["outcome"] = compute_outcome(exp)
    exp["status"] = "complete"
    exp["updated"] = now_iso()
    save_exp(exp)
    o = exp["outcome"] or {}
    print(f"done. winner: {o.get('winner_name','?')} at {o.get('winner_value','?')} {exp['primary_metric']}"
          + (f"  ({o['delta_pct']:+.1f}% vs control)" if o.get("delta_pct") is not None else ""))
    print("  next: conclude, then build")


def cmd_conclude(a):
    exp = load_exp(a.id)
    if a.conclusion is not None:
        exp["conclusion"] = a.conclusion
    if a.decision is not None:
        exp["decision"] = a.decision
    if a.status:
        exp["status"] = a.status
    exp["updated"] = now_iso()
    save_exp(exp)
    print(f"updated conclusion/decision for {a.id}")


def cmd_build(a):
    exps = []
    for p in sorted(glob.glob(os.path.join(EXP_DIR, "*.json"))):
        with open(p) as f:
            exps.append(json.load(f))
    exps.sort(key=lambda e: e["id"], reverse=True)
    out = {"updated_at": now_iso(), "count": len(exps), "experiments": exps}
    os.makedirs(os.path.dirname(WEB_JSON), exist_ok=True)
    with open(WEB_JSON, "w") as f:
        json.dump(out, f, indent=2)
    print(f"built {len(exps)} experiment(s) → {os.path.relpath(WEB_JSON, ROOT)}")


def cmd_list(a):
    ps = sorted(glob.glob(os.path.join(EXP_DIR, "*.json")))
    if not ps:
        print("no experiments yet — create one with `experiment.py new`")
        return
    for p in ps:
        with open(p) as f:
            e = json.load(f)
        o = e.get("outcome") or {}
        print(f"  {e['id']}  [{e['status']:>8}]  {e['title']}"
              + (f"  → {o.get('winner_name')} {o.get('winner_value')}{e['primary_metric']}" if o else ""))


def main():
    ap = argparse.ArgumentParser(description="PastaPass experiment tracker")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("new"); p.set_defaults(fn=cmd_new)
    p.add_argument("--title", required=True); p.add_argument("--hypothesis", required=True)
    p.add_argument("--metric", default="p50_ms", choices=METRIC_KEYS)
    p.add_argument("--method", default="")

    p = sub.add_parser("add-variant"); p.set_defaults(fn=cmd_add_variant)
    p.add_argument("--id", required=True); p.add_argument("--key", required=True)
    p.add_argument("--name", required=True); p.add_argument("--approach", required=True)
    p.add_argument("--lang", required=True); p.add_argument("--trials", type=int, default=25)

    p = sub.add_parser("run"); p.set_defaults(fn=cmd_run); p.add_argument("--id", required=True)

    p = sub.add_parser("conclude"); p.set_defaults(fn=cmd_conclude)
    p.add_argument("--id", required=True); p.add_argument("--conclusion", default=None)
    p.add_argument("--decision", default=None)
    p.add_argument("--status", default=None, choices=["planned", "running", "complete", "archived"])

    sub.add_parser("build").set_defaults(fn=cmd_build)
    sub.add_parser("list").set_defaults(fn=cmd_list)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
