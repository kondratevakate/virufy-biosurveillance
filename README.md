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


## World map continuation (2026-11-19, Codex)

The `ux-audit` branch continues deployment baseline `825a469` with two map layers:
- Epidemiological dashboards: 10 countries with opened dashboards/data pages,
  16 EU/WHO-listed countries not confirmed, and UAE authority/programme pages.
- Respiratory signals: dated CDC US measurements, UKHSA England measurements,
  historical US/UK aviation wastewater, and UAE research references.

Availability is not disease burden. This is a partial source inventory and saved
snapshots, not a live feed. Every item retains its own observation/check date;
UKHSA numbers cover England only. Its homepage was rechecked on 2026-11-19.
The UKHSA snapshot is recorded explicitly in `eval/build_world_signals.py`.

Validation: 14 tests passed; both layers, country details, selection reset and
390 px mobile layout checked in a local browser. No horizontal overflow was
observed. Service-worker and asset versions were v19 at that point (v20 since the single-map change). No detector, experiment,
server or nginx configuration changes were made.

This continuation is local only, not pushed, merged or deployed. Next: deploy
after Kate approves this version, then verify the served assets and both layers.
The previously reported nginx CSP block of Cloudflare Analytics remains unresolved;
the footer claim about counting visits has not been reverified or corrected here.
Local preview: `python -m http.server 8765 --bind 127.0.0.1 --directory app`.


## Source catalog and MCP server (2026-11-19)

`catalog/` holds a first version of an open catalog of what each country publishes about
infectious-disease surveillance, and a read-only MCP server over it.

- `catalog/schema.json`: the record format (JSON Schema 2020-12). One record per public source:
  country, record class (dashboard, measurement, reference), signal type, status, what it covers,
  the observed period, URL, licence and the closest existing standard.
- `catalog/build_catalog.py`: builds `catalog/catalog.json` from `app/data/world_signals.json`,
  the verified source list of the prototype. The version is a required argument:
  `python -I catalog/build_catalog.py --catalog-version 0.1.0`.
- `catalog/catalog.json`: version 0.1.0, 40 records for 27 countries (13 confirmed dashboards,
  16 listed by the EU or WHO and not confirmed, 6 dated measurements, 5 references).
- `catalog/mcp_server.py`: MCP server (stdio) with three tools: `list_countries`,
  `sources_for_country`, `latest_signals`. It reads the catalog file only: no network, no writes,
  no user data.

What it is not. It is not a new terminology or data standard: wastewater already has PHES-ODM,
case line lists have the Global.health outbreak schema, and WHO publishes SMART Guidelines. The
`related_standard` field points to the closest one; no source has been mapped to it yet. It is
not a live feed: values are snapshots with their dates. A `null` licence means the licence was not
checked. It is not medical advice.

Run the server:

    python -m venv .venv-mcp
    .venv-mcp/Scripts/python -m pip install -r catalog/requirements.txt
    .venv-mcp/Scripts/python catalog/mcp_server.py

Tests: `tests/test_catalog.py` (schema, builder, tools, and one end-to-end call over stdio).
