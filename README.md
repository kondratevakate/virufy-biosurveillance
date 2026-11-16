# Virufy biosurveillance prototype

Prototype for the Future Health Digital Innovation Challenge 2026 (Challenge 06, population and workforce health early warning).

A phone counts coughs in the browser and shares only counts per 15 minutes with a zone code. A dashboard compares each zone with its own baseline and shows aviation wastewater pathogen series as a second signal. Not a medical device.

## Layout

- `app/`: the web app (PWA). `index.html`, `app.js`, `styles.css`, `sw.js`; `vendor/tasks-audio` is MediaPipe Tasks Audio 0.10.21 (Apache-2.0); `models/` holds the detector (see `models/SOURCE.md`); `data/` holds the derived wastewater series and the detector evaluation summary.
- `eval/eval_esc50.py`: clip-level evaluation of the detector on ESC-50, protocol in the script header.
- `backtest/build_wastewater_series.py`: weekly positivity series and early-warning flags from the aviation wastewater dataset.

## Data

Registered in `C:\Projects\data\_registry\datasets.json`:
- `esc50-33c8ce9eb2cf`: ESC-50, CC BY-NC 3.0.
- `zenodo-18432347-aviation-wastewater-qpcr-v2`: aviation wastewater qPCR, CC BY 4.0.

No audio is stored in this repository or by the app.

## Run

    python -m venv .venv && .venv/Scripts/python -m pip install mediapipe numpy soundfile openpyxl
    .venv/Scripts/python eval/eval_esc50.py --model app/models/yamnet.tflite --esc50 <ESC-50 root> --out eval/results
    .venv/Scripts/python backtest/build_wastewater_series.py --raw <wastewater raw/> --out app/data/wastewater.json
    python -m http.server 8765 --directory app

The microphone needs a secure context: `http://localhost` on the computer, HTTPS on a phone.

## Results so far (2026-11-16)

Detector on ESC-50 (2000 clips, 40 coughs), threshold chosen by 5-fold cross-validation: ROC AUC 0.991, sensitivity 92.5% (95% CI 80.1 to 97.4), specificity 91.2% (89.9 to 92.4), 63 false positives per hour of non-cough sound, mostly sneezing and breathing. The app uses a stricter threshold of 0.5 (sensitivity 82.5%, 3.3 false positives per hour on the same clips; exploratory, chosen on the same data).
