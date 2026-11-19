"""Build the world outline and the world signal list bundled with the prototype.

Inputs (all real, public, already checked):
  - Natural Earth 1:110m admin-0 countries GeoJSON (public domain), path given on the command line
  - app/data/monitors.json: EU/EEA national monitors opened and checked on its "checked" date
  - app/data/wastewater.json: aviation wastewater qPCR, Zenodo doi:10.5281/zenodo.18432347 (CC BY 4.0)
  - CDC percent of tests positive (data.cdc.gov seuz-s2cv), registry id
    cdc-seuz-s2cv-percent-tests-positive-2026-11-18
  - CDC ILINet national (Delphi Epidata fluview), registry id cdc-ilinet-delphi-fluview-2026-11-18

Outputs: app/data/world.json (outline) and app/data/world_signals.json (one entry per country
with a real public signal; every entry carries its source and date). No synthetic data.

Usage:
  python -I eval/build_world_signals.py <ne_110m_admin_0_countries.geojson> <C:/Projects/data root>
"""
import csv
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
APP_DATA = REPO / "app" / "data"
CDC_PCT = "datasets/surveillance/cdc-seuz-s2cv-percent-tests-positive/2026-11-18/raw/seuz-s2cv.csv"
CDC_ILI = "datasets/surveillance/cdc-ilinet-delphi-fluview/2026-11-18/raw/nat.json"


def outline(geojson_path: Path) -> dict:
    gj = json.loads(geojson_path.read_text(encoding="utf-8"))
    countries = []
    for f in gj["features"]:
        p, g = f["properties"], f["geometry"]
        a3 = p.get("ADM0_A3") or p.get("ISO_A3")
        if a3 == "ATA":  # Antarctica takes space and carries no signal
            continue
        polys = g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]
        rings = []
        for poly in polys:
            ring = poly[0]  # outer ring only; holes do not matter at this scale
            pts = []
            for lon, lat in ring:
                pt = [round(lon, 1), round(lat, 1)]
                if not pts or pts[-1] != pt:
                    pts.append(pt)
            if len(pts) >= 4:
                rings.append(pts)
        if rings:
            countries.append({"a3": a3, "name": p.get("NAME_EN") or p.get("NAME"), "rings": rings})
    return {"source": "Natural Earth 1:110m admin-0 countries (public domain), naturalearthdata.com",
            "countries": countries}


def cdc_percent_positive(data_root: Path) -> dict:
    rows = list(csv.DictReader((data_root / CDC_PCT).open(encoding="utf-8")))
    last = max(r["week_end"] for r in rows)
    vals = {r["pathogen"]: float(r["percent_test_positivity"]) for r in rows if r["week_end"] == last}
    return {"week_end": last[:10], "values": vals}


def cdc_ilinet(data_root: Path) -> dict:
    rows = json.loads((data_root / CDC_ILI).read_text(encoding="utf-8"))["epidata"]
    last = max(rows, key=lambda r: r["epiweek"])
    return {"epiweek": last["epiweek"], "release_date": last["release_date"],
            "num_ili": last["num_ili"], "num_patients": last["num_patients"], "ili": last["ili"]}


def signals(data_root: Path) -> dict:
    monitors = json.loads((APP_DATA / "monitors.json").read_text(encoding="utf-8"))
    ww = json.loads((APP_DATA / "wastewater.json").read_text(encoding="utf-8"))
    pct, ili = cdc_percent_positive(data_root), cdc_ilinet(data_root)
    out = {}

    def add(a3, status, item):
        entry = out.setdefault(a3, {"status": status, "items": []})
        rank = {"live": 3, "listed": 2, "past": 1, "studies": 0}
        if rank[status] > rank[entry["status"]]:
            entry["status"] = status
        entry["items"].append(item)

    for a3, lst in monitors["national"].items():
        for m in lst:
            add(a3, "live", {"name": m["name"], "kind": m["signal"], "detail": m["pathogens"], "url": m["url"],
                             "date": f"page opened {monitors['checked']}"})
    for a3 in monitors["not_confirmed"]:
        add(a3, "listed", {"name": "National monitor listed by the EU or WHO", "kind": "not confirmed by us",
                           "detail": "We could not open and confirm it.", "url": "",
                           "date": f"checked {monitors['checked']}"})

    v = pct["values"]
    add("USA", "live", {"name": "CDC percent of tests positive (NREVSS)", "kind": "Clinical laboratory tests",
                        "detail": f"COVID-19 {v.get('COVID-19')}%, influenza {v.get('Influenza')}%, RSV {v.get('RSV')}% of tests positive",
                        "url": "https://data.cdc.gov/d/seuz-s2cv", "date": f"week ending {pct['week_end']}"})
    week = str(ili["epiweek"])
    add("USA", "live", {"name": "CDC ILINet, influenza-like illness", "kind": "Outpatient visits",
                        "detail": f"{ili['ili']:.1f}% of {ili['num_patients']:,} outpatient visits were for influenza-like illness",
                        "url": "https://www.cdc.gov/fluview/", "date": f"week {week[:4]}w{week[4:]}, released {ili['release_date']}"})
    for country, a3 in (("US", "USA"), ("UK", "GBR")):
        series = [s for s in ww["series"] if s["country"] == country]
        if series:
            weeks = f"{series[0]['weeks'][0]} to {series[0]['weeks'][-1]}"
            add(a3, "past", {"name": "Aviation wastewater from arriving aircraft",
                             "kind": "Wastewater, research dataset",
                             "detail": ", ".join(s["target"] for s in series) + "; weekly share of positive samples",
                             "url": "https://doi.org/10.5281/zenodo.18432347", "date": weeks})
    add("ARE", "studies", {"name": "Published wastewater studies, no running public data",
                           "kind": "Research", "detail": "Aircraft wastewater at Dubai Airport (2020) and 453 sites across the UAE (2020 to 2022).",
                           "url": "./#uae", "date": "papers 2021 and 2023"})
    return {
        "checked": "2026-11-18",
        "note": "Real public signals only. A country without an entry has no public signal listed here; that does not mean it has none.",
        "eu_level": [
            {"name": "ERVISS", "operator": "ECDC, WHO/Europe", "url": "https://erviss.org/",
             "detail": "Influenza, RSV, SARS-CoV-2; weekly"},
            {"name": "EU Wastewater Surveillance Dashboard", "operator": "European Commission HERA, JRC",
             "url": "https://wastewater-observatory.jrc.ec.europa.eu/#/content/the-eu-dashboard",
             "detail": "SARS-CoV-2, influenza, RSV; 11 countries"},
        ],
        "countries": out,
    }


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    geo, data_root = Path(sys.argv[1]), Path(sys.argv[2])
    (APP_DATA / "world.json").write_text(json.dumps(outline(geo), separators=(",", ":")), encoding="utf-8")
    (APP_DATA / "world_signals.json").write_text(json.dumps(signals(data_root), indent=1, ensure_ascii=False) + "\n",
                                                 encoding="utf-8")
    print("wrote", APP_DATA / "world.json", APP_DATA / "world_signals.json")


if __name__ == "__main__":
    main()
