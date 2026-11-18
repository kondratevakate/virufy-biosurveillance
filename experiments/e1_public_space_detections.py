"""E1: detections per hour of the deployed cough detector in real public-space audio.

Protocol: experiments/PROTOCOL.md, section E1 (frozen 2026-11-18).
Reads TAU Urban Acoustic Scenes 2019 clips straight from the downloaded zip archives;
nothing is extracted to disk and no audio is written anywhere.

Usage:
    python experiments/e1_public_space_detections.py --model app/models/yamnet.tflite \
        --zips <audio.1.zip> <audio.2.zip> --out experiments/results/e1
"""
import argparse
import hashlib
import io
import json
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

import numpy as np
import soundfile as sf
from mediapipe.tasks.python import audio
from mediapipe.tasks.python.components.containers import audio_data as mp_audio_data
from mediapipe.tasks.python.core import base_options as mp_base_options
from scipy.stats import chi2

THRESHOLDS = (0.3, 0.5, 0.7)  # 0.5 is the app threshold and the primary one


def poisson_ci(k: int, hours: float) -> tuple[float, float]:
    lo = chi2.ppf(0.025, 2 * k) / 2 if k > 0 else 0.0
    hi = chi2.ppf(0.975, 2 * (k + 1)) / 2
    return (float(lo / hours), float(hi / hours))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, type=Path)
    ap.add_argument("--zips", required=True, nargs="+", type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--limit", type=int, default=0, help="smoke test: stop after this many clips")
    args = ap.parse_args()

    opts = audio.AudioClassifierOptions(
        base_options=mp_base_options.BaseOptions(model_asset_path=str(args.model)),
        running_mode=audio.RunningMode.AUDIO_CLIPS, max_results=-1)
    events = {t: defaultdict(int) for t in THRESHOLDS}
    seconds, clips, per_clip = defaultdict(float), defaultdict(int), []
    done = 0
    with audio.AudioClassifier.create_from_options(opts) as clf:
        for zp in args.zips:
            with zipfile.ZipFile(zp) as z:
                names = sorted(n for n in z.namelist() if n.lower().endswith(".wav"))
                for name in names:
                    scene = Path(name).name.split("-")[0]
                    x, sr = sf.read(io.BytesIO(z.read(name)), dtype="float32", always_2d=True)
                    x = x.mean(axis=1)
                    scores = []
                    for r in clf.classify(mp_audio_data.AudioData.create_from_array(x, sr)):
                        scores.append(next((c.score for c in r.classifications[0].categories
                                            if c.category_name == "Cough"), 0.0))
                    for t in THRESHOLDS:
                        events[t][scene] += sum(s >= t for s in scores)
                    seconds[scene] += len(x) / sr
                    clips[scene] += 1
                    per_clip.append((Path(name).name, scene, round(max(scores, default=0.0), 4)))
                    done += 1
                    if done % 100 == 0:
                        print(f"scored {done} clips", flush=True)
                    if args.limit and done >= args.limit:
                        break
            if args.limit and done >= args.limit:
                break

    res = {"model_sha256": hashlib.sha256(args.model.read_bytes()).hexdigest(),
           "archives": [p.name for p in args.zips], "n_clips": done,
           "hours": sum(seconds.values()) / 3600, "by_threshold": {}}
    for t in THRESHOLDS:
        tot_k, tot_h = sum(events[t].values()), sum(seconds.values()) / 3600
        res["by_threshold"][str(t)] = {
            "overall": {"events": tot_k, "per_hour": tot_k / tot_h, "ci95": poisson_ci(tot_k, tot_h)},
            "by_scene": {s: {"clips": clips[s], "hours": seconds[s] / 3600, "events": events[t][s],
                             "per_hour": events[t][s] / (seconds[s] / 3600),
                             "ci95": poisson_ci(events[t][s], seconds[s] / 3600)} for s in sorted(seconds)},
        }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "e1_summary.json").write_text(json.dumps(res, indent=1))
    with open(args.out / "e1_clip_scores.csv", "w", encoding="utf-8") as f:
        f.write("clip,scene,max_cough_score\n")
        f.writelines(f"{a},{b},{c}\n" for a, b, c in per_clip)
    p = res["by_threshold"]["0.5"]
    print(f"{done} clips, {res['hours']:.2f} h; threshold 0.5: {p['overall']['per_hour']:.2f} events/h "
          f"(95% CI {p['overall']['ci95'][0]:.2f} to {p['overall']['ci95'][1]:.2f})")
    for s, v in p["by_scene"].items():
        print(f"  {s:18s} {v['hours']:.2f} h  {v['events']:3d} events  {v['per_hour']:.2f}/h")
    return 0


if __name__ == "__main__":
    sys.exit(main())
