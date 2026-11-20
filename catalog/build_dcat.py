"""Export catalog/catalog.json as a DCAT catalog in JSON-LD: catalog/catalog.dcat.jsonld.

DCAT (W3C Data Catalog Vocabulary, https://www.w3.org/TR/vocab-dcat-3/) is the format open-data
portals use to describe datasets, including data.europa.eu; HealthDCAT-AP, the metadata profile
of the European Health Data Space, is built on it. This export uses core DCAT and Dublin Core
terms only. It does not claim conformance with DCAT-AP or HealthDCAT-AP: their mandatory
properties (publisher, contact point, access rights and others) are not known for most sources.

Fields of our record format that have no DCAT term are kept under the `vb:` namespace, so the
JSON-LD carries the same information as catalog.json.

Usage:
  python -I catalog/build_dcat.py
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "catalog.json"
OUT = HERE / "catalog.dcat.jsonld"
BASE = "https://virufy.healthaiatlas.com/data/catalog.dcat.jsonld"

CONTEXT = {
    "dcat": "http://www.w3.org/ns/dcat#",
    "dcterms": "http://purl.org/dc/terms/",
    "xsd": "http://www.w3.org/2001/XMLSchema#",
    "vb": "https://virufy.healthaiatlas.com/data/catalog.schema.json#",
}
# EU Publications Office authority tables; the country table uses ISO 3166-1 alpha-3 codes.
COUNTRY = "http://publications.europa.eu/resource/authority/country/"
THEME_HEALTH = "http://publications.europa.eu/resource/authority/data-theme/HEAL"
# Licences we could attach a URI to. Other licence strings stay literals.
LICENCE_URI = {
    "CC BY 4.0": "https://creativecommons.org/licenses/by/4.0/",
    "Open Government Licence v3.0": "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
}


def dataset(record: dict) -> dict:
    node = {
        "@id": f"{BASE}#{record['id']}",
        "@type": "dcat:Dataset",
        "dcterms:identifier": record["id"],
        "dcterms:title": {"@value": record["name"], "@language": "en"},
        "dcterms:description": {"@value": record["detail"], "@language": "en"},
        "dcterms:spatial": {"@id": COUNTRY + record["country"]},
        "dcat:theme": {"@id": THEME_HEALTH},
        "dcat:keyword": [record["signal_type"].replace("_", " "), record["record_class"]],
        "vb:record_class": record["record_class"],
        "vb:signal_type": record["signal_type"],
        "vb:status": record["status"],
        "vb:observed": record["observed"],
    }
    if record["url"]:
        node["dcat:landingPage"] = {"@id": record["url"]}
    if record["licence"]:
        uri = LICENCE_URI.get(record["licence"])
        node["dcterms:license"] = {"@id": uri} if uri else record["licence"]
    if record["related_standard"]:
        node["vb:related_standard"] = record["related_standard"]
    return node


def build() -> dict:
    cat = json.loads(SRC.read_text(encoding="utf-8"))
    return {
        "@context": CONTEXT,
        "@id": BASE,
        "@type": "dcat:Catalog",
        "dcterms:title": {"@value": "Virufy catalog of public respiratory surveillance sources", "@language": "en"},
        "dcterms:description": {"@value": cat["note"], "@language": "en"},
        "dcat:version": cat["catalog_version"],
        "dcterms:modified": {"@value": cat["checked"], "@type": "xsd:date"},
        "dcat:theme": {"@id": THEME_HEALTH},
        "dcat:dataset": [dataset(r) for r in cat["records"]],
    }


if __name__ == "__main__":
    doc = build()
    OUT.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(doc['dcat:dataset'])} datasets -> {OUT}")
