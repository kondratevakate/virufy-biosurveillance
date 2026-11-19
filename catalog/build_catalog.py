"""Build catalog/catalog.json from the verified source list of the prototype.

Input: app/data/world_signals.json (built by eval/build_world_signals.py from sources that were
opened and checked; no synthetic data). Output: one flat list of records in the format of
catalog/schema.json.

The catalog version is a required argument: there is no default, so a rebuild can never be
stamped with a stale version by accident.

Usage:
  python -I catalog/build_catalog.py --catalog-version 0.1.0
"""
import argparse
import json
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SIGNALS = REPO / "app" / "data" / "world_signals.json"
OUTLINE = REPO / "app" / "data" / "world.json"
OUT = Path(__file__).resolve().parent / "catalog.json"

# Source wording ("kind") to the controlled vocabulary of the schema. An unknown kind raises.
SIGNAL_TYPE = {
    "Wastewater": "wastewater",
    "Wastewater, research dataset": "wastewater",
    "Clinical laboratory tests": "clinical_lab_tests",
    "Outpatient visits": "outpatient_visits",
    "Reported cases": "reported_cases",
    "Hospital admissions": "hospital_admissions",
    "Genomic": "genomic",
    "Excess mortality": "excess_mortality",
    "Public surveillance portal": "surveillance_portal",
    "Public health dashboard": "surveillance_portal",
    "Authority / programme page": "authority_page",
    "Research": "research",
    "not confirmed by us": "unspecified",
}
STATUS = {"live": "confirmed", "listed": "listed_unconfirmed", "programme": "no_public_data",
          "studies": "no_public_data", "past": "historical"}
# Closest existing standard per signal type. A pointer, not a completed mapping.
RELATED_STANDARD = {
    "wastewater": "PHES-ODM (Public Health Environmental Surveillance Open Data Model)",
    "reported_cases": "Global.health outbreak schema",
}
# Licences stated by the source itself. Anything else stays null: not checked.
LICENCE_BY_URL = (
    ("doi.org/10.5281/zenodo.18432347", "CC BY 4.0"),
    ("ukhsa-dashboard.data.gov.uk", "Open Government Licence v3.0"),
)
# Countries too small for the 1:110m outline still need a name.
EXTRA_NAMES = {"MLT": "Malta", "LIE": "Liechtenstein"}


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def build(catalog_version: str) -> dict:
    sig = json.loads(SIGNALS.read_text(encoding="utf-8"))
    names = {c["a3"]: c["name"] for c in json.loads(OUTLINE.read_text(encoding="utf-8"))["countries"]}
    names.update(EXTRA_NAMES)
    records, seen = [], set()
    for layer, record_class in (("dashboards", "dashboard"), ("respiratory", "measurement")):
        for a3 in sorted(sig["layers"][layer]):
            entry = sig["layers"][layer][a3]
            status = STATUS[entry["status"]]
            for item in entry["items"]:
                signal_type = SIGNAL_TYPE[item["kind"]]
                rclass = "reference" if status == "no_public_data" else record_class
                rid = f"{a3}-{slug(item['name'])}"
                if rid in seen:  # the same source can appear in both layers
                    rid = f"{rid}-{record_class}"
                assert rid not in seen, rid
                seen.add(rid)
                url = item["url"] or None
                licence = next((lic for part, lic in LICENCE_BY_URL if url and part in url), None)
                records.append({
                    "id": rid, "country": a3, "country_name": names[a3], "name": item["name"],
                    "record_class": rclass, "signal_type": signal_type, "status": status,
                    "detail": item["detail"], "observed": item["date"], "url": url,
                    "licence": licence, "related_standard": RELATED_STANDARD.get(signal_type),
                })
    return {
        "catalog_version": catalog_version,
        "checked": sig["checked"],
        "note": ("Partial inventory of public sources, saved snapshots only. A country without a record "
                 "has no source listed here; that does not mean it has none. Not a live feed and not "
                 "medical advice."),
        "records": records,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--catalog-version", required=True, help="semantic version, for example 0.1.0")
    args = parser.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.catalog_version):
        parser.error("--catalog-version must look like 0.1.0")
    catalog = build(args.catalog_version)
    OUT.write_text(json.dumps(catalog, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(catalog['records'])} records, {len({r['country'] for r in catalog['records']})} countries -> {OUT}")
