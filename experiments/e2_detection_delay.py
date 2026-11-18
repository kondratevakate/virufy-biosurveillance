"""E2: detection delay versus load and detector error, by simulation.

Protocol: experiments/PROTOCOL.md, section E2 (frozen 2026-11-18).
Observed daily count: Y ~ Poisson(E * w_dow * (s * b * r + phi)), with r = 1 before the outbreak
and 1 + kappa from its start. All counts are simulated; s and phi come from E-series measurements.

Usage:
    python experiments/e2_detection_delay.py --phi 0 <phi_overall> <phi_worst> --out experiments/results/e2
"""
import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

SENS = 0.825                       # ESC-50, app threshold 0.5
LOADS = (50, 200, 1000, 5000)      # person-hours per day
KAPPAS = (0.1, 0.2, 0.5, 1.0)
BACKGROUNDS = (0.5, 2.0)           # coughs per person-hour, ASSUMED
DOW = np.array([1, 1, 1, 1, 1, 0.8, 0.8])  # ASSUMED weekday/weekend factor
LOAD_SD = 0.2                      # ASSUMED lognormal sd of daily load
BURN, PRE, POST = 56, 30, 120      # days: baseline estimation, in-control lead-in, follow-up
ARL0, DESIGN_RATIO = 180.0, 1.5
N_CAL, T_CAL, N_RUN, SEED = 1000, 1500, 2000, 20261118


def simulate(rng, n, T, E, b, phi, kappa=0.0, start=None, nb_size=None):
    """Return loads and counts, shape (n, BURN + T). The outbreak starts at index BURN + start."""
    days = BURN + T
    dow = DOW[np.arange(days) % 7]
    load = E * dow * rng.lognormal(-LOAD_SD**2 / 2, LOAD_SD, size=(n, days))
    r = np.ones(days)
    if start is not None:
        r[BURN + start:] = 1 + kappa
    mu = load * (SENS * b * r + phi)
    y = rng.poisson(mu) if nb_size is None else rng.negative_binomial(nb_size, nb_size / (nb_size + mu))
    return load, y


def stat_cusum(load, y):
    """Poisson CUSUM with load offset; baseline rate per weekday estimated on the burn-in."""
    n, days = y.shape
    d = np.arange(days) % 7
    rate = np.stack([y[:, :BURN][:, d[:BURN] == k].sum(1) / load[:, :BURN][:, d[:BURN] == k].sum(1) for k in range(7)], 1)
    mu0 = load * rate[:, d]
    inc = y * np.log(DESIGN_RATIO) - mu0 * (DESIGN_RATIO - 1)
    s, out = np.zeros(n), np.zeros((n, days - BURN))
    for t in range(BURN, days):
        s = np.maximum(0.0, s + inc[:, t])
        out[:, t - BURN] = s
    return out


def _window(x, lo, hi):
    """Stack x[:, t-lo .. t-hi] for every monitored day t, shape (n, T, lo-hi+1)."""
    T = x.shape[1] - BURN
    return np.stack([x[:, BURN - k: BURN - k + T] for k in range(lo, hi - 1, -1)], 2)


def stat_mad(load, y):
    """Prototype rule: robust z of today's rate against the previous 8 days."""
    x = y / load
    w = _window(x, 8, 1)
    med = np.median(w, 2)
    mad = np.median(np.abs(w - med[:, :, None]), 2) * 1.4826
    return (x[:, BURN:] - med) / np.maximum(mad, 1e-9)


def stat_c2(load, y):
    """EARS C2-style: 7-day mean and sd with a 2-day guard band."""
    x = y / load
    w = _window(x, 9, 3)
    return (x[:, BURN:] - w.mean(2)) / np.maximum(w.std(2, ddof=1), 1e-9)


DETECTORS = {"cusum": stat_cusum, "mad_rule": stat_mad, "ears_c2": stat_c2}


def first_alarm(stat, h):
    hit = stat > h
    return np.where(hit.any(1), hit.argmax(1), stat.shape[1])


def calibrate(stat):
    """Threshold whose in-control mean run length is ARL0 (run lengths capped at T_CAL)."""
    lo, hi = np.percentile(stat, 50), stat.max() + 1
    for _ in range(60):
        mid = (lo + hi) / 2
        if (first_alarm(stat, mid) + 1).mean() < ARL0:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def kl_info(E, b, phi, kappa):
    mu0 = E * DOW.mean() * (SENS * b + phi)
    mu1 = E * DOW.mean() * (SENS * b * (1 + kappa) + phi)
    return mu1 * np.log(mu1 / mu0) - (mu1 - mu0)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phi", required=True, nargs="+", type=float, help="false alarms per listening hour")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--smoke", action="store_true", help="one cell, few runs, for timing")
    args = ap.parse_args()
    rng = np.random.default_rng(SEED)
    loads, bgs, phis = (LOADS[:1], BACKGROUNDS[:1], args.phi[:1]) if args.smoke else (LOADS, BACKGROUNDS, args.phi)
    n_cal, n_run = (100, 200) if args.smoke else (N_CAL, N_RUN)

    rows = []
    for b in bgs:
        for phi in phis:
            for E in loads:
                load, y = simulate(rng, n_cal, T_CAL, E, b, phi)
                h = {name: calibrate(f(load, y)) for name, f in DETECTORS.items()}
                # robustness: same thresholds under overdispersed counts
                load_nb, y_nb = simulate(rng, n_cal, T_CAL, E, b, phi, nb_size=10)
                arl_nb = {name: float((first_alarm(f(load_nb, y_nb), h[name]) + 1).mean()) for name, f in DETECTORS.items()}
                for kappa in KAPPAS:
                    load, y = simulate(rng, n_run, PRE + POST, E, b, phi, kappa, start=PRE)
                    theory = float(np.log(ARL0) / kl_info(E, b, phi, kappa))
                    for name, f in DETECTORS.items():
                        fa = first_alarm(f(load, y), h[name])
                        ok = fa >= PRE                     # no false alarm before the outbreak
                        delay = np.minimum(fa[ok] - PRE + 1, POST)
                        rows.append({
                            "background": b, "phi": phi, "load": E, "kappa": kappa, "detector": name,
                            "threshold": round(float(h[name]), 4), "arl0_nb_size10": round(arl_nb[name], 1),
                            "n_runs": int(ok.sum()), "add_days": round(float(delay.mean()), 2),
                            "median_delay": float(np.median(delay)),
                            "p_detect_7d": round(float((delay <= 7).mean()), 3),
                            "p_detect_14d": round(float((delay <= 14).mean()), 3),
                            "share_undetected_120d": round(float((fa[ok] >= PRE + POST).mean()), 3),
                            "cusum_theory_days": round(theory, 2),
                        })
                print(f"b={b} phi={phi:g} E={E}: done", flush=True)

    args.out.mkdir(parents=True, exist_ok=True)
    name = "e2_smoke" if args.smoke else "e2_results"
    with open(args.out / f"{name}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    (args.out / f"{name}_meta.json").write_text(json.dumps({
        "sensitivity": SENS, "phi_values": list(phis), "arl0_days": ARL0, "design_ratio": DESIGN_RATIO,
        "assumed": {"background_coughs_per_person_hour": list(BACKGROUNDS), "dow_factors": DOW.tolist(), "load_sd": LOAD_SD},
        "n_calibration_runs": n_cal, "n_runs_per_cell": n_run, "seed": SEED}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
