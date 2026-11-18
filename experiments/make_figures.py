"""Figures for experiments E1 to E3 from the saved result files.

Usage:
    python experiments/make_figures.py --results experiments/results --out experiments/figures
"""
import argparse
import csv
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

SCENE_NAMES = {"airport": "Airport", "bus": "Bus", "metro": "Metro (in train)", "metro_station": "Metro station",
               "park": "Park", "public_square": "Public square", "shopping_mall": "Shopping mall",
               "street_pedestrian": "Pedestrian street", "street_traffic": "Street with traffic", "tram": "Tram"}
DETECTOR_NAMES = {"cusum": "Poisson CUSUM with load offset", "mad_rule": "Prototype rule (median and MAD, 8 days)",
                  "ears_c2": "EARS C2-style rule (7-day mean and SD)"}


def fig_e1(res, out):
    by = res["by_threshold"]["0.5"]["by_scene"]
    scenes = sorted(by, key=lambda s: by[s]["per_hour"])
    rate = [by[s]["per_hour"] for s in scenes]
    err = [[r - by[s]["ci95"][0] for r, s in zip(rate, scenes)], [by[s]["ci95"][1] - r for r, s in zip(rate, scenes)]]
    fig, ax = plt.subplots(figsize=(7, 4))
    ax.barh([SCENE_NAMES.get(s, s) for s in scenes], rate, xerr=err, color="#0f5c4d", ecolor="#555", capsize=3)
    ax.set_xlabel("Cough detections per hour of audio (score at least 0.5), with 95% interval")
    ax.set_title(f"Detector firing rate in public places ({res['hours']:.1f} h of TAU Urban Acoustic Scenes 2019)", fontsize=10)
    fig.tight_layout(); fig.savefig(out / "e1_detections_per_hour.png", dpi=200); plt.close(fig)


def fig_e2(rows, out):
    phis = sorted({float(r["phi"]) for r in rows})
    b = min(float(r["background"]) for r in rows)
    fig, axes = plt.subplots(1, len(phis), figsize=(4.6 * len(phis), 4), sharey=True)
    axes = [axes] if len(phis) == 1 else list(axes)
    for ax, phi in zip(axes, phis):
        for det, style in (("cusum", "-o"), ("ears_c2", "--s"), ("mad_rule", ":^")):
            sel = sorted((r for r in rows if float(r["phi"]) == phi and float(r["background"]) == b
                          and float(r["kappa"]) == 0.5 and r["detector"] == det), key=lambda r: float(r["load"]))
            ax.plot([float(r["load"]) for r in sel], [float(r["add_days"]) for r in sel], style, label=DETECTOR_NAMES[det])
        sel = sorted((r for r in rows if float(r["phi"]) == phi and float(r["background"]) == b
                      and float(r["kappa"]) == 0.5 and r["detector"] == "cusum"), key=lambda r: float(r["load"]))
        ax.plot([float(r["load"]) for r in sel], [max(float(r["cusum_theory_days"]), 1.0) for r in sel], "k-", lw=0.8,
                label="First-order theory for CUSUM, ln(ARL) / information")
        ax.set_xscale("log"); ax.set_yscale("log")
        ax.set_xlabel("Load: person-hours of listening per day")
        ax.set_title(f"Detector false alarms: {phi:g} per listening hour", fontsize=10)
    axes[0].set_ylabel("Average days to detect a 50% rise in cough rate")
    axes[0].legend(fontsize=7, loc="upper right")
    fig.suptitle(f"Simulated detection delay at one false alarm per 180 days (background {b:g} coughs per person-hour, assumed)", fontsize=10)
    fig.tight_layout(); fig.savefig(out / "e2_delay_vs_load.png", dpi=200); plt.close(fig)


def fig_e3(res, out):
    pairs = [p for p in res["pairs"] if p["role"] == "primary"]
    fig, axes = plt.subplots(len(pairs), 1, figsize=(8, 2.6 * len(pairs)), sharex=True)
    for ax, p in zip(axes, pairs):
        x = range(len(p["weeks"]))
        ax.plot(x, p["wastewater_positivity"], color="#0f5c4d", label="Aviation wastewater: share of positive samples")
        ax.set_ylim(0, 1.05); ax.set_ylabel("Wastewater", color="#0f5c4d")
        ax2 = ax.twinx()
        ax2.plot(x, p["clinical_percent_positive"], color="#e07a2f", label="US clinical tests: percent positive")
        ax2.set_ylabel("Clinical, %", color="#e07a2f")
        lo, hi = p["lag_ci95"]
        ax.set_title(f"{p['pair']}: best lag {p['best_lag_weeks']:+d} weeks (95% interval {lo:+.0f} to {hi:+.0f}), "
                     f"Spearman {p['rho_at_best_lag']:.2f}", fontsize=9)
        step = max(len(p["weeks"]) // 8, 1)
        ax.set_xticks(list(x)[::step]); ax.set_xticklabels([w[2:] for w in p["weeks"]][::step], fontsize=7)
    axes[-1].set_xlabel("Week ending (positive lag means wastewater moves first)")
    fig.tight_layout(); fig.savefig(out / "e3_wastewater_vs_clinical.png", dpi=200); plt.close(fig)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    done = []
    if (p := args.results / "e1" / "e1_summary.json").exists():
        fig_e1(json.loads(p.read_text()), args.out); done.append("e1")
    if (p := args.results / "e2" / "e2_results.csv").exists():
        fig_e2(list(csv.DictReader(open(p, encoding="utf-8"))), args.out); done.append("e2")
    if (p := args.results / "e3" / "e3_summary.json").exists():
        fig_e3(json.loads(p.read_text()), args.out); done.append("e3")
    print("figures written for:", ", ".join(done) or "nothing (no result files found)")
    return 0 if done else 1


if __name__ == "__main__":
    sys.exit(main())
