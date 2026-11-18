"""Merge per-archive E1 summaries (events and hours add up) into experiments/results/e1.

Usage:
    python experiments/e1_merge.py --parts experiments/results/e1_parts --out experiments/results/e1
"""
import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from e1_public_space_detections import poisson_ci  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--parts", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()
    parts = sorted(args.parts.glob("*/e1_summary.json"))
    if not parts:
        print("ERROR: no part summaries found", file=sys.stderr)
        return 1
    docs = [json.loads(p.read_text()) for p in parts]
    if len({d["model_sha256"] for d in docs}) != 1:
        print("ERROR: parts were scored with different model files", file=sys.stderr)
        return 1
    res = {"model_sha256": docs[0]["model_sha256"], "archives": sum((d["archives"] for d in docs), []),
           "n_clips": sum(d["n_clips"] for d in docs), "hours": sum(d["hours"] for d in docs), "by_threshold": {}}
    for t in docs[0]["by_threshold"]:
        ev, hrs, clips = defaultdict(int), defaultdict(float), defaultdict(int)
        for d in docs:
            for s, v in d["by_threshold"][t]["by_scene"].items():
                ev[s] += v["events"]; hrs[s] += v["hours"]; clips[s] += v["clips"]
        k, h = sum(ev.values()), sum(hrs.values())
        res["by_threshold"][t] = {
            "overall": {"events": k, "per_hour": k / h, "ci95": poisson_ci(k, h)},
            "by_scene": {s: {"clips": clips[s], "hours": hrs[s], "events": ev[s], "per_hour": ev[s] / hrs[s],
                             "ci95": poisson_ci(ev[s], hrs[s])} for s in sorted(hrs)}}
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "e1_summary.json").write_text(json.dumps(res, indent=1))
    with open(args.out / "e1_clip_scores.csv", "w", encoding="utf-8") as f:
        f.write("clip,scene,max_cough_score\n")
        for p in parts:
            f.writelines((p.parent / "e1_clip_scores.csv").read_text(encoding="utf-8").splitlines(keepends=True)[1:])
    for t, v in res["by_threshold"].items():
        print(f"threshold {t}: {v['overall']['events']} events in {res['hours']:.2f} h = {v['overall']['per_hour']:.2f}/h "
              f"({v['overall']['ci95'][0]:.2f} to {v['overall']['ci95'][1]:.2f})")
        if t == "0.5":
            for s, x in v["by_scene"].items():
                print(f"   {s:18s} {x['hours']:.2f} h {x['events']:3d} events {x['per_hour']:.2f}/h")
    return 0


if __name__ == "__main__":
    sys.exit(main())
