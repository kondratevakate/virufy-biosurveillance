"""E3: lag between US aviation wastewater positivity and national clinical percent positive.

Protocol: experiments/PROTOCOL.md, section E3 (frozen 2026-11-18).

Usage:
    python experiments/e3_wastewater_vs_clinical.py --wastewater <USdata.xlsx> \
        --clinical <seuz-s2cv.csv> --out experiments/results/e3
"""
import argparse
import csv
import datetime as dt
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from openpyxl import load_workbook
from scipy.stats import spearmanr

PAIRS = [  # (wastewater target, clinical pathogen, label, role)
    ("Severe acute respiratory syndrome coronavirus 2", "COVID-19", "SARS-CoV-2", "primary"),
    ("Influenza A virus", "Influenza", "Influenza A", "primary"),
    ("Influenza B virus", "Influenza", "Influenza B", "secondary"),
    ("Human orthopneumovirus", "RSV", "RSV", "primary"),
]
LAGS = range(-6, 7)
MIN_SAMPLES, BLOCK, N_BOOT, SEED = 3, 4, 2000, 20261118


def mmwr_week_end(d: dt.date) -> dt.date:
    """Saturday that ends the MMWR week (Sunday to Saturday) containing d."""
    return d + dt.timedelta(days=(5 - d.weekday()) % 7)


def load_wastewater(path: Path):
    ws = load_workbook(path, read_only=True, data_only=True).active
    rows = ws.iter_rows(values_only=True)
    next(rows)
    cells = defaultdict(lambda: [0, 0])
    for target, conc, date in rows:
        if target is None or date is None:
            continue
        if isinstance(date, dt.datetime):
            date = date.date()
        key = (str(target).strip(), mmwr_week_end(date))
        cells[key][1] += 1
        cells[key][0] += int(float(conc or 0) > 0)
    return cells


def load_clinical(path: Path):
    out = {}
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["percent_test_positivity"] in ("", None):
                continue
            week = dt.date.fromisoformat(r["week_end"][:10])
            out[(r["pathogen"], week)] = float(r["percent_test_positivity"])
    return out


def best_lag(ww: np.ndarray, cl_by_lag: dict) -> tuple[int, dict]:
    """cl_by_lag[k][i] is the clinical value k weeks after wastewater week i."""
    rho = {}
    for k in LAGS:
        c = cl_by_lag[k]
        ok = ~np.isnan(ww) & ~np.isnan(c)
        rho[k] = float(spearmanr(ww[ok], c[ok]).statistic) if ok.sum() >= 8 and np.ptp(ww[ok]) > 0 else float("nan")
    valid = {k: v for k, v in rho.items() if not np.isnan(v)}
    return (max(valid, key=valid.get) if valid else 0), rho


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wastewater", required=True, type=Path)
    ap.add_argument("--clinical", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    cells, clinical = load_wastewater(args.wastewater), load_clinical(args.clinical)
    weeks = sorted({w for (_, w) in cells})
    rng = np.random.default_rng(SEED)
    results = []
    for target, pathogen, label, role in PAIRS:
        ww = np.array([cells[(target, w)][0] / cells[(target, w)][1]
                       if cells[(target, w)][1] >= MIN_SAMPLES else np.nan for w in weeks])
        cl_by_lag = {k: np.array([clinical.get((pathogen, w + dt.timedelta(weeks=k)), np.nan) for w in weeks])
                     for k in LAGS}
        lag, rho = best_lag(ww, cl_by_lag)
        # moving-block bootstrap over wastewater weeks, keeping each week's clinical neighbours
        n = len(weeks)
        starts_max = n - BLOCK + 1
        boot = []
        for _ in range(N_BOOT):
            idx = np.concatenate([np.arange(s, s + BLOCK) for s in rng.integers(0, starts_max, size=int(np.ceil(n / BLOCK)))])[:n]
            boot.append(best_lag(ww[idx], {k: v[idx] for k, v in cl_by_lag.items()})[0])
        lo, hi = np.percentile(boot, [2.5, 97.5])
        results.append({
            "pair": f"{label} (wastewater) vs {pathogen} (clinical)", "role": role,
            "n_weeks_used": int((~np.isnan(ww)).sum()), "first_week_end": str(weeks[0]), "last_week_end": str(weeks[-1]),
            "best_lag_weeks": int(lag), "rho_at_best_lag": rho[lag], "rho_at_lag_0": rho[0],
            "lag_ci95": [float(lo), float(hi)], "share_boot_wastewater_leads": float(np.mean(np.array(boot) > 0)),
            "rho_by_lag": {str(k): (None if np.isnan(v) else round(v, 3)) for k, v in rho.items()},
            "wastewater_positivity": [None if np.isnan(x) else round(float(x), 3) for x in ww],
            "clinical_percent_positive": [None if np.isnan(x) else float(x) for x in cl_by_lag[0]],
            "weeks": [str(w) for w in weeks],
        })
        print(f"{label}: n={results[-1]['n_weeks_used']} best lag {lag:+d} wk (95% CI {lo:+.0f} to {hi:+.0f}), "
              f"rho {rho[lag]:.2f}, rho at lag 0 {rho[0]:.2f}, wastewater leads in {results[-1]['share_boot_wastewater_leads']:.0%} of resamples")
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "e3_summary.json").write_text(json.dumps({"positive_lag_means": "wastewater leads", "pairs": results}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
