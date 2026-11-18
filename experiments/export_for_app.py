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

BACKGROUND = 0.5  # assumed coughs per person-hour used by the demo zones


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True, type=Path)
    ap.add_argument("--app", required=True, type=Path)
    args = ap.parse_args()

    e1 = json.loads((args.results / "e1" / "e1_summary.json").read_text())
    e3 = json.loads((args.results / "e3" / "e3_summary.json").read_text())
    rows = list(csv.DictReader(open(args.results / "e2" / "e2_results.csv", encoding="utf-8")))
    meta = json.loads((args.results / "e2" / "e2_results_meta.json").read_text())
    phi = e1["by_threshold"]["0.5"]["overall"]["per_hour"]
    phi_used = min(meta["phi_values"], key=lambda v: abs(v - phi))

    def cell(load, kappa, det, phi_v=phi_used, b=BACKGROUND):
        return next(r for r in rows if float(r["load"]) == load and float(r["kappa"]) == kappa and r["detector"] == det
                    and float(r["phi"]) == phi_v and float(r["background"]) == b)

    loads = sorted({float(r["load"]) for r in rows})
    detection = {"sensitivity": meta["sensitivity"], "phi": phi_used, "background": BACKGROUND,
                 "cusum_threshold_by_load": {str(int(L)): float(cell(L, 0.5, "cusum")["threshold"]) for L in loads},
                 "note": "Alarm levels calibrated by simulation in experiment E2 for one false alarm per 180 days."}
    (args.app / "data" / "detection.json").write_text(json.dumps(detection, indent=1))

    o = e1["by_threshold"]["0.5"]["overall"]
    worst = max(e1["by_threshold"]["0.5"]["by_scene"].items(), key=lambda kv: kv[1]["per_hour"])
    c200, c1000 = cell(200, 0.5, "cusum"), cell(1000, 0.5, "cusum")
    m200, clean = cell(200, 0.5, "mad_rule"), cell(200, 0.5, "cusum", phi_v=0.0)
    lag = "; ".join(f"{p['pair'].split(' (')[0]} {p['best_lag_weeks']:+d} weeks ({p['lag_ci95'][0]:+.0f} to {p['lag_ci95'][1]:+.0f}), rho {p['rho_at_best_lag']:.2f}"
                    for p in e3["pairs"] if p["role"] == "primary")
    items = [
        {"title": "E1. How often the detector fires in real public places",
         "text": f"{e1['hours']:.1f} hours of TAU Urban Acoustic Scenes 2019 recordings ({e1['n_clips']} clips, 10 kinds of place): "
                 f"{o['per_hour']:.2f} detections per hour (95% interval {o['ci95'][0]:.2f} to {o['ci95'][1]:.2f}); most in "
                 f"'{worst[0]}' at {worst[1]['per_hour']:.2f} per hour. The recordings contain real, unlabelled coughs, "
                 "so this is an upper bound on the false-alarm rate."},
        {"title": "E2. How fast a sustained rise is detected (simulation)",
         "text": f"For a 50% rise in cough rate and one false alarm per 180 days, the Poisson CUSUM needs on average "
                 f"{float(c200['add_days']):.1f} days at 200 listening hours per day and {float(c1000['add_days']):.1f} days at 1000; "
                 f"the simple day-against-last-week rule needs {float(m200['add_days']):.0f} days at 200 hours and misses "
                 f"{float(m200['share_undetected_120d']):.0%} of rises within 120 days. Without detector false alarms the CUSUM delay "
                 f"at 200 hours would be {float(clean['add_days']):.1f} days. Counts are simulated; the background cough rate "
                 f"({BACKGROUND} per person-hour) is assumed."},
        {"title": "E3. Aviation wastewater against US clinical positivity (real data)",
         "text": f"Weekly series, March 2024 to January 2025. Best lag (positive means wastewater first) with 95% interval: {lag}. "
                 "The series move together, but one season is too short to show that wastewater leads."},
    ]
    (args.app / "data" / "experiments.json").write_text(json.dumps(items, indent=1))
    print(json.dumps(detection, indent=1)); [print("-", i["text"]) for i in items]
    return 0


if __name__ == "__main__":
    sys.exit(main())
