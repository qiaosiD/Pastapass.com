#!/usr/bin/env python3
"""Pure-Python statistics for the PastaPass benchmark — no numpy/scipy.

Latency samples are right-skewed with a long tail, so mean±std alone is
misleading. This module provides the honest treatment:

  * summary()            — percentiles (p50/p90/p95/p99), IQR, mean, std, CV
  * bootstrap_ci_median  — 95% CI on the median by resampling (no normality assumed)
  * mann_whitney_u       — nonparametric "are these two distributions different?"
  * cliffs_delta         — nonparametric effect size (how big is the difference?)

Everything is deterministic: the bootstrap is seeded so the same CSVs always
produce the same JSON (reproducible from the commit).
"""
import math
import random


def percentile(xs, q):
    """Linear-interpolation percentile (type 7, numpy default). q in [0, 1]."""
    if not xs:
        return float("nan")
    s = sorted(xs)
    n = len(s)
    if n == 1:
        return float(s[0])
    h = (n - 1) * q
    lo = int(math.floor(h))
    hi = min(lo + 1, n - 1)
    return s[lo] + (h - lo) * (s[hi] - s[lo])


def mean(xs):
    return sum(xs) / len(xs)


def std(xs, ddof=1):
    """Sample standard deviation (ddof=1)."""
    n = len(xs)
    if n <= ddof:
        return 0.0
    m = mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (n - ddof))


def summary(xs):
    """Full descriptive summary of a sample (all values in the sample's units)."""
    s = sorted(xs)
    m = mean(s)
    sd = std(s)
    q25 = percentile(s, 0.25)
    q75 = percentile(s, 0.75)
    return {
        "n": len(s),
        "mean": m,
        "std": sd,
        "min": float(s[0]),
        "max": float(s[-1]),
        "p50": percentile(s, 0.50),
        "p90": percentile(s, 0.90),
        "p95": percentile(s, 0.95),
        "p99": percentile(s, 0.99),
        "q25": q25,
        "q75": q75,
        "iqr": q75 - q25,
        "cv": (sd / m) if m else 0.0,  # coefficient of variation (spread relative to level)
    }


def bootstrap_ci_median(xs, iters=2000, alpha=0.05, seed=1234):
    """95% CI on the median by nonparametric bootstrap. Returns (lo, hi)."""
    if len(xs) < 2:
        v = float(xs[0]) if xs else float("nan")
        return (v, v)
    rng = random.Random(seed)
    n = len(xs)
    meds = []
    for _ in range(iters):
        sample = [xs[rng.randrange(n)] for _ in range(n)]
        meds.append(percentile(sample, 0.50))
    return (percentile(meds, alpha / 2), percentile(meds, 1 - alpha / 2))


def _phi(z):
    """Standard-normal CDF."""
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def mann_whitney_u(a, b):
    """Mann-Whitney U test (two-sided, normal approximation with tie + continuity
    correction). Returns {U, U_a, U_b, z, p}. Valid for n >= ~8 per group."""
    na, nb = len(a), len(b)
    if na == 0 or nb == 0:
        return {"U": float("nan"), "U_a": float("nan"), "U_b": float("nan"), "z": 0.0, "p": 1.0}
    combined = [(v, 0) for v in a] + [(v, 1) for v in b]
    combined.sort(key=lambda t: t[0])
    N = len(combined)

    # average ranks (1-based), handling ties; accumulate tie-correction term
    ranks = [0.0] * N
    tie_term = 0.0
    i = 0
    while i < N:
        j = i
        while j + 1 < N and combined[j + 1][0] == combined[i][0]:
            j += 1
        avg_rank = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[k] = avg_rank
        t = j - i + 1
        if t > 1:
            tie_term += t ** 3 - t
        i = j + 1

    r_a = sum(r for r, (_, g) in zip(ranks, combined) if g == 0)
    u_a = r_a - na * (na + 1) / 2.0
    u_b = na * nb - u_a
    u = min(u_a, u_b)

    mu = na * nb / 2.0
    var = (na * nb / 12.0) * ((N + 1) - tie_term / (N * (N - 1)))
    if var <= 0:
        return {"U": u, "U_a": u_a, "U_b": u_b, "z": 0.0, "p": 1.0}
    sigma = math.sqrt(var)
    z = (abs(u - mu) - 0.5) / sigma  # continuity correction
    p = 2.0 * (1.0 - _phi(z))
    return {"U": u, "U_a": u_a, "U_b": u_b, "z": z, "p": max(0.0, min(1.0, p))}


def cliffs_delta(a, b):
    """Cliff's delta effect size in [-1, 1]. delta>0 => values in `a` tend larger.
    Returns {delta, abs, label} with Romano et al. magnitude thresholds."""
    na, nb = len(a), len(b)
    if na == 0 or nb == 0:
        return {"delta": 0.0, "abs": 0.0, "label": "n/a"}
    gt = lt = 0
    for x in a:
        for y in b:
            if x > y:
                gt += 1
            elif x < y:
                lt += 1
    delta = (gt - lt) / (na * nb)
    ad = abs(delta)
    label = ("negligible" if ad < 0.147 else "small" if ad < 0.33
             else "medium" if ad < 0.474 else "large")
    return {"delta": delta, "abs": ad, "label": label}


if __name__ == "__main__":
    # tiny self-check
    a = [1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9]
    b = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4]
    print("summary(a):", {k: round(v, 3) for k, v in summary(a).items()})
    print("ci_median(a):", tuple(round(x, 3) for x in bootstrap_ci_median(a)))
    print("mwu(a,b):", {k: round(v, 4) for k, v in mann_whitney_u(a, b).items()})
    print("cliffs(a,b):", cliffs_delta(a, b))
