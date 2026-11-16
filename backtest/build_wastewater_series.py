"""Weekly aviation-wastewater positivity series and early-warning flags for the dashboard.

Input: the Zenodo aviation wastewater qPCR dataset (doi:10.5281/zenodo.18432347,
CC BY 4.0), registry id zenodo-18432347-aviation-wastewater-qpcr-v2. Rows are
sample-by-target qPCR concentrations with a collection date; sample IDs are not
given, so the series is built at date level.

Series: for each country (US, UK), respiratory target and ISO week, the share of
measurements with a concentration above zero (positivity) and the number of
measurements behind it.

Early-warning rule (fixed before looking at the flags, 2026-11-16): a week is
flagged when positivity exceeds the median of the previous 8 weeks by more than
2 scaled MADs and by at least 0.15 in absolute terms, with at least 4 prior weeks
and 5 measurements in the week. This is the demo rule of the prototype; its lead
time against clinical surveillance is not measured here.

Usage:
    python backtest/build_wastewater_series.py --raw <dataset raw/ folder> --out app/data/wastewater.json
"""
import argparse
import datetime as dt
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from openpyxl import load_workbook

FILES = {"US": "USdata.xlsx", "UK": "UKdataN.xlsx"}
TARGETS = {
    "Severe acute respiratory syndrome coronavirus 2": "SARS-CoV-2",
    "Influenza A virus": "Influenza A",
    "Influenza B virus": "Influenza B",
    "Human orthopneumovirus": "RSV",
}
BASELINE_WEEKS, MIN_PRIOR, MIN_N = 8, 4, 5
Z_LIMIT, ABS_LIMIT = 2.0, 0.15


def read_rows(path: Path):
    ws = load_workbook(path, read_only=True, data_only=True).active
    rows = ws.iter_rows(values_only=True)
    header = next(rows)
    if [str(h).strip() for h in header[:3]] != ["Target", "Concentration", "Date"]:
        raise ValueError(f"unexpected header in {path.name}: {header}")
    for target, conc, date in rows:
        if target is None or date is None:
            continue
        if isinstance(date, dt.datetime):
            date = date.date()
        yield str(target).strip(), float(conc or 0.0), date


def week_key(d: dt.date) -> str:
    y, w, _ = d.isocalendar()
    return f"{y}-W{w:02d}"


def flags(pos: list[float], n: list[int]) -> list[dict]:
    out = []
    for i, (p, k) in enumerate(zip(pos, n)):
        prior = [x for x in pos[max(0, i - BASELINE_WEEKS):i] if x is not None]
        rec = {"flag": False, "baseline": None, "z": None}
        if p is not None and len(prior) >= MIN_PRIOR and k >= MIN_N:
            med = float(np.median(prior))
            mad = float(np.median(np.abs(np.array(prior) - med))) * 1.4826
            z = (p - med) / mad if mad > 0 else (float("inf") if p > med else 0.0)
            rec = {"flag": bool(z > Z_LIMIT and p - med >= ABS_LIMIT), "baseline": med,
                   "z": None if np.isinf(z) else round(z, 2)}
        out.append(rec)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    result = {"source": "Aviation wastewater qPCR dataset (US-UK research collaboration), Zenodo, "
                        "doi:10.5281/zenodo.18432347, CC BY 4.0",
              "rule": {"baseline_weeks": BASELINE_WEEKS, "min_prior_weeks": MIN_PRIOR,
                       "min_measurements": MIN_N, "z_limit": Z_LIMIT, "abs_limit": ABS_LIMIT},
              "series": []}
    for country, fname in FILES.items():
        path = args.raw / fname
        if not path.exists():
            print(f"ERROR: missing {path}", file=sys.stderr)
            return 1
        cells = defaultdict(lambda: [0, 0])  # (target, week) -> [positive, total]
        weeks = set()
        for target, conc, date in read_rows(path):
            if target not in TARGETS:
                continue
            wk = week_key(date)
            weeks.add(wk)
            cells[(target, wk)][1] += 1
            cells[(target, wk)][0] += int(conc > 0)
        weeks = sorted(weeks)
        for target, label in TARGETS.items():
            n = [cells[(target, w)][1] for w in weeks]
            pos = [cells[(target, w)][0] / k if k else None for (w, k) in zip(weeks, n)]
            fl = flags(pos, n)
            result["series"].append({
                "country": country, "target": label, "weeks": weeks,
                "positivity": [None if p is None else round(p, 3) for p in pos],
                "n": n, "flags": fl,
                "n_flagged_weeks": sum(f["flag"] for f in fl),
            })
            print(f"{country} {label}: {len(weeks)} weeks, {sum(n)} measurements, "
                  f"{sum(f['flag'] for f in fl)} flagged weeks")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
