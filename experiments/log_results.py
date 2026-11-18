"""Mirror the headline numbers of E1 to E3 (and the ESC-50 check) into a local Trackio project.

One run per experiment; nothing is uploaded (no space_id is set).

Usage:
    python experiments/log_results.py --results experiments/results --esc50 eval/results/esc50_summary.json
"""
import argparse
import csv
import json
import sys
from pathlib import Path

import trackio

PROJECT = "virufy-biosurveillance"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True, type=Path)
    ap.add_argument("--esc50", required=True, type=Path)
    args = ap.parse_args()
    logged = []

    if args.esc50.exists():
        s = json.loads(args.esc50.read_text())
        trackio.init(project=PROJECT, name="rq1-esc50-detector", config={"model_sha256": s["model_sha256"]})
        trackio.log({"roc_auc": s["roc_auc_all_clips"], "sensitivity": s["sensitivity"], "specificity": s["specificity"],
                     "false_positives_per_hour": s["false_positives_per_hour"]})
        trackio.finish(); logged.append("esc50")

    if (p := args.results / "e1" / "e1_summary.json").exists():
        s = json.loads(p.read_text())
        trackio.init(project=PROJECT, name="e1-public-space-detections", config={"hours": s["hours"], "n_clips": s["n_clips"]})
        for thr, v in s["by_threshold"].items():
            trackio.log({"threshold": float(thr), "events_per_hour": v["overall"]["per_hour"],
                         "ci_low": v["overall"]["ci95"][0], "ci_high": v["overall"]["ci95"][1]})
        trackio.finish(); logged.append("e1")

    if (p := args.results / "e2" / "e2_results.csv").exists():
        meta = json.loads((args.results / "e2" / "e2_results_meta.json").read_text())
        trackio.init(project=PROJECT, name="e2-detection-delay", config=meta)
        for r in csv.DictReader(open(p, encoding="utf-8")):
            trackio.log({f"add_days/{r['detector']}": float(r["add_days"]), "load": float(r["load"]),
                         "kappa": float(r["kappa"]), "phi": float(r["phi"]), "background": float(r["background"]),
                         "cusum_theory_days": float(r["cusum_theory_days"])})
        trackio.finish(); logged.append("e2")

    if (p := args.results / "e3" / "e3_summary.json").exists():
        s = json.loads(p.read_text())
        trackio.init(project=PROJECT, name="e3-wastewater-vs-clinical")
        for i, pair in enumerate(s["pairs"]):
            trackio.log({"pair_index": i, "best_lag_weeks": pair["best_lag_weeks"], "rho_at_best_lag": pair["rho_at_best_lag"],
                         "lag_ci_low": pair["lag_ci95"][0], "lag_ci_high": pair["lag_ci95"][1]})
        trackio.finish(); logged.append("e3")

    print("logged to Trackio project", PROJECT, ":", ", ".join(logged))
    return 0


if __name__ == "__main__":
    sys.exit(main())
