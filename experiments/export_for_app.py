"""Write the app's detection settings and experiment summary from the saved results.

Outputs app/data/detection.json (CUSUM alarm levels calibrated in E2, detector error from
ESC-50 and E1) and app/data/experiments.json (plain-language summary shown in the About tab).

Usage:
    python experiments/export_for_app.py --results experiments/results --app app
"""
import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import e2_detection_delay as e2  # noqa: E402

BACKGROUND = 0.5   # assumed coughs per person-hour used by the demo zones
SENS = 0.825       # ESC-50, app threshold
PHI = 0.48         # upper 95% bound of the E1 firing rate, per listening hour
SEED = 20261118


def calibrate_bank(load):
    """Alarm levels of the CUSUM bank for the demo zones, same procedure as experiment E2."""
    rng = np.random.default_rng(SEED + int(load))
    ld, y = e2.simulate(rng, e2.N_CAL, e2.T_CAL, load, BACKGROUND, PHI, sens=SENS)
    levels = [e2.calibrate(e2.stat_cusum(ld, y, r)) for r in e2.BANK_RATIOS]
    stat = np.max([e2.stat_cusum(ld, y, r) / c for r, c in zip(e2.BANK_RATIOS, levels)], axis=0)
    # a member that never leaves zero in control gets a tiny level: any positive value then alarms
    return {"levels": [max(round(float(c), 4), 1e-6) for c in levels], "alarm": round(float(e2.calibrate(stat)), 4)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True, type=Path)
    ap.add_argument("--app", required=True, type=Path)
    args = ap.parse_args()

    e1 = json.loads((args.results / "e1" / "e1_summary.json").read_text())
    e3 = json.loads((args.results / "e3" / "e3_summary.json").read_text())
    rows = list(csv.DictReader(open(args.results / "e2" / "e2_results.csv", encoding="utf-8")))

    def cell(load, kappa, det, phi=PHI, b=BACKGROUND, sens=SENS):
        return next(r for r in rows if float(r["load"]) == load and float(r["kappa"]) == kappa and r["detector"] == det
                    and float(r["phi"]) == phi and float(r["background"]) == b and float(r["sensitivity"]) == sens)

    detection = {"sensitivity": SENS, "phi": PHI, "background": BACKGROUND, "ratios": list(e2.BANK_RATIOS),
                 "bank_by_load": {str(L): calibrate_bank(L) for L in (50, 200, 1000)},
                 "note": "CUSUM bank calibrated by simulation, as in experiment E2, for one false alarm per 180 days."}
    (args.app / "data" / "detection.json").write_text(json.dumps(detection, indent=1))

    o = e1["by_threshold"]["0.5"]["overall"]
    scenes = ", ".join(sorted(e1["by_threshold"]["0.5"]["by_scene"])).replace("_", " ")
    k200, k1000, c1000 = cell(200, 0.5, "cusum_bank"), cell(1000, 0.5, "cusum_bank"), cell(1000, 0.5, "cusum", phi=3.3)
    m200, low = cell(200, 0.5, "mad_rule"), cell(200, 0.5, "cusum_bank", sens=0.2)
    n_cells = len({(r["sensitivity"], r["background"], r["phi"], r["load"], r["kappa"]) for r in rows})
    lag = "; ".join(f"{p['pair'].split(' (')[0]} {p['best_lag_weeks']:+d} weeks ({p['lag_ci95'][0]:+.0f} to {p['lag_ci95'][1]:+.0f}), rho {p['rho_at_best_lag']:.2f}"
                    for p in e3["pairs"] if p["role"] == "primary")
    items = [
        {"title": "E1. The detector in real public places",
         "text": f"{e1['hours']:.1f} hours of TAU Urban Acoustic Scenes 2019 recordings ({e1['n_clips']} clips: {scenes}): "
                 f"{o['events']} detections, so at most {o['ci95'][1]:.2f} per hour (95% bound). No false alarms from crowd noise, "
                 "but the coughs these crowds must contain were not caught either: the off-the-shelf model hears coughs close to "
                 "the microphone, not across a hall. Phone counting is supported; fixed microphones in public places need a model "
                 "trained for distant coughs."},
        {"title": "E2. How fast a sustained rise is detected (simulation)",
         "text": f"{n_cells} settings, each calibrated to one false alarm per 180 days. For a 50% rise in cough rate, a bank of "
                 f"Poisson CUSUMs needs on average {float(k200['add_days']):.1f} days at 200 listening hours per day and "
                 f"{float(k1000['add_days']):.1f} at 1000; the simple day-against-last-week rule needs {float(m200['add_days']):.0f} days "
                 f"at 200 hours and misses {float(m200['share_undetected_120d']):.0%} of rises within 120 days. A single CUSUM tuned "
                 f"for a 50% rise goes blind when detector false alarms dilute the rise (average delay {float(c1000['add_days']):.0f} "
                 f"days at 3.3 false alarms per hour); the bank does not. If the detector catches only 20% of coughs, the delay at "
                 f"200 hours grows to {float(low['add_days']):.1f} days. Counts are simulated; the background cough rate "
                 f"({BACKGROUND} per person-hour) is assumed. With counts more variable than Poisson the false-alarm budget is not "
                 "kept, so the alarm level must be calibrated on real data."},
        {"title": "E3. Aviation wastewater against US clinical positivity (real data)",
         "text": f"Weekly series, March 2024 to January 2025. Best lag (positive means wastewater first) with 95% interval: {lag}. "
                 "The series move together, but one season is too short to show that wastewater leads."},
    ]
    (args.app / "data" / "experiments.json").write_text(json.dumps(items, indent=1))
    print(json.dumps(detection, indent=1)); [print("-", i["text"]) for i in items]
    return 0


if __name__ == "__main__":
    sys.exit(main())
