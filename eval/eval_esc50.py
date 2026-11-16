"""Clip-level evaluation of the on-device cough detector on ESC-50.

Protocol (fixed before the first run, 2026-11-16):
- Model: MediaPipe YAMNet audio classifier, float32 v1, the same .tflite file the
  phone app serves from app/models/. Its SHA-256 is written into the results; its
  source is recorded in app/models/SOURCE.md.
- Data: ESC-50 at a pinned commit, all 2000 clips (5 s, 44.1 kHz, mono, 50 classes,
  40 per class). Positive = class "coughing" (40 clips); negative = the other 1960.
- Clip score: maximum over YAMNet windows of the "Cough" class score.
- Threshold: 5-fold cross-validation over the ESC-50 folds. For each held-out fold
  the threshold maximising Youden's J on the other four folds is applied to the
  held-out fold. Pooled held-out predictions give sensitivity and specificity.
- Reported: ROC AUC on all clips, pooled sensitivity and specificity with Wilson
  95% intervals, false positives per hour of non-cough audio, and the false
  positive rate for the acoustically closest classes (sneezing, breathing,
  snoring, laughing, clapping).

pandas is not used: Windows Smart App Control blocks its compiled extension on
this workstation, and the analysis needs only csv and numpy.

Usage:
    python eval/eval_esc50.py --model app/models/yamnet.tflite \
        --esc50 <ESC-50 root with meta/ and audio/> --out eval/results
"""
import argparse
import csv
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np
import soundfile as sf
from mediapipe.tasks.python import audio
from mediapipe.tasks.python.components.containers import audio_data as mp_audio_data
from mediapipe.tasks.python.core import base_options as mp_base_options

COUGH_LABEL = "Cough"
CLOSE_CLASSES = ["sneezing", "breathing", "snoring", "laughing", "clapping"]
CLIP_SECONDS = 5.0


def cough_score(classifier, wav_path: Path) -> float:
    samples, sr = sf.read(wav_path, dtype="float32", always_2d=False)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    data = mp_audio_data.AudioData.create_from_array(samples, sr)
    results = classifier.classify(data)
    best = 0.0
    for r in results:
        for c in r.classifications[0].categories:
            if c.category_name == COUGH_LABEL:
                best = max(best, c.score)
    return best


def roc_auc(y: np.ndarray, s: np.ndarray) -> float:
    # Mann-Whitney formulation with average ranks for ties
    order = s.argsort()
    ranks = np.empty(len(s), dtype=float)
    ranks[order] = np.arange(1, len(s) + 1)
    for v in np.unique(s):
        idx = s == v
        ranks[idx] = ranks[idx].mean()
    n1, n0 = y.sum(), (1 - y).sum()
    return float((ranks[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def youden_threshold(y: np.ndarray, s: np.ndarray) -> float:
    best_t, best_j = 0.5, -1.0
    for t in np.unique(s):
        pred = s >= t
        sens = (pred & (y == 1)).sum() / max((y == 1).sum(), 1)
        spec = (~pred & (y == 0)).sum() / max((y == 0).sum(), 1)
        if sens + spec - 1 > best_j:
            best_j, best_t = sens + spec - 1, float(t)
    return best_t


def wilson(k: int, n: int) -> tuple[float, float]:
    if n == 0:
        return (float("nan"), float("nan"))
    z, p = 1.96, k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * np.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (float((c - h) / d), float((c + h) / d))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, type=Path)
    ap.add_argument("--esc50", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    if not args.model.exists():
        print(f"ERROR: model file not found: {args.model}", file=sys.stderr)
        return 1
    with open(args.esc50 / "meta" / "esc50.csv", newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if len(rows) != 2000:
        print(f"ERROR: expected 2000 ESC-50 rows, found {len(rows)}", file=sys.stderr)
        return 1
    model_sha = hashlib.sha256(args.model.read_bytes()).hexdigest()

    opts = audio.AudioClassifierOptions(
        base_options=mp_base_options.BaseOptions(model_asset_path=str(args.model)),
        running_mode=audio.RunningMode.AUDIO_CLIPS,
        max_results=-1,
    )
    scores = []
    with audio.AudioClassifier.create_from_options(opts) as clf:
        for i, row in enumerate(rows, 1):
            scores.append(cough_score(clf, args.esc50 / "audio" / row["filename"]))
            if i % 200 == 0:
                print(f"scored {i}/{len(rows)} clips", flush=True)

    cat = np.array([r["category"] for r in rows])
    fold = np.array([int(r["fold"]) for r in rows])
    s = np.array(scores)
    y = (cat == "coughing").astype(int)
    pred = np.zeros(len(rows), dtype=int)
    thresholds = {}
    for k in sorted(set(fold.tolist())):
        train, test = fold != k, fold == k
        t = youden_threshold(y[train], s[train])
        thresholds[k] = t
        pred[test] = (s[test] >= t).astype(int)

    pos, neg = y == 1, y == 0
    tp, fp = int(pred[pos].sum()), int(pred[neg].sum())
    neg_hours = int(neg.sum()) * CLIP_SECONDS / 3600
    close = {c: {"n": int((cat == c).sum()), "flagged_as_cough": int(pred[cat == c].sum())} for c in CLOSE_CLASSES}
    top_fp = dict(Counter(cat[neg & (pred == 1)].tolist()).most_common(8))
    spec_lo, spec_hi = wilson(fp, int(neg.sum()))

    res = {
        "model_file": args.model.name,
        "model_sha256": model_sha,
        "n_clips": len(rows), "n_cough": int(pos.sum()), "n_noncough": int(neg.sum()),
        "roc_auc_all_clips": roc_auc(y, s),
        "fold_thresholds": thresholds,
        "sensitivity": tp / int(pos.sum()), "sensitivity_ci95": wilson(tp, int(pos.sum())),
        "specificity": 1 - fp / int(neg.sum()), "specificity_ci95": (1 - spec_hi, 1 - spec_lo),
        "false_positives": fp, "noncough_hours": neg_hours, "false_positives_per_hour": fp / neg_hours,
        "close_classes": close, "top_false_positive_classes": top_fp,
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "esc50_summary.json").write_text(json.dumps(res, indent=2))
    with open(args.out / "esc50_scores.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["filename", "fold", "category", "cough_score", "pred"])
        for r, sc, p in zip(rows, scores, pred):
            w.writerow([r["filename"], r["fold"], r["category"], f"{sc:.6f}", int(p)])
    print(json.dumps(res, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
