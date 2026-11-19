"""Read-only MCP server over the biosurveillance source catalog.

Tools:
  list_countries()          countries that have at least one record, with counts per record class
  sources_for_country(c)    everything the catalog lists for one country
  latest_signals(c)         only the dated measurements saved for one country

The server reads catalog/catalog.json and nothing else: no network access, no writes, no user
data. Every answer repeats the catalog note, so a client cannot present a saved snapshot as a
live feed or as medical advice.

Run (stdio transport):
  python catalog/mcp_server.py
"""
import json
from pathlib import Path

from mcp.server.fastmcp import FastMCP

CATALOG_PATH = Path(__file__).resolve().parent / "catalog.json"

mcp = FastMCP(
    "virufy-biosurveillance-catalog",
    instructions=("Catalog of public infectious-disease surveillance sources per country. "
                  "Saved snapshots with dates, a partial inventory, not a live feed and not medical advice. "
                  "Always show the source URL and the observed date with any value."),
)


def load_catalog() -> dict:
    """Read the catalog on every call: the file is small, and a rebuilt catalog is picked up at once."""
    try:
        return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"catalog file is missing: {CATALOG_PATH}. Build it with catalog/build_catalog.py") from exc


def resolve_country(catalog: dict, country: str) -> str:
    """Accept an ISO 3166-1 alpha-3 code or an English country name; raise a clear error otherwise."""
    wanted = country.strip()
    if not wanted or len(wanted) > 60:
        raise ValueError("country must be an ISO alpha-3 code such as DEU or an English country name")
    known = {r["country"]: r["country_name"] for r in catalog["records"]}
    if wanted.upper() in known:
        return wanted.upper()
    by_name = {name.lower(): a3 for a3, name in known.items()}
    if wanted.lower() in by_name:
        return by_name[wanted.lower()]
    raise ValueError(f"no record for '{wanted}'. The catalog is partial: a missing country has no source listed "
                     f"here, which does not mean it has none. Call list_countries for the countries covered.")


def envelope(catalog: dict, **payload) -> dict:
    return {"catalog_version": catalog["catalog_version"], "checked": catalog["checked"],
            "note": catalog["note"], **payload}


@mcp.tool()
def list_countries() -> dict:
    """List the countries covered by the catalog, with the number of dashboards, measurements and references."""
    catalog = load_catalog()
    countries: dict[str, dict] = {}
    for r in catalog["records"]:
        c = countries.setdefault(r["country"], {"country": r["country"], "country_name": r["country_name"],
                                                "dashboard": 0, "measurement": 0, "reference": 0})
        c[r["record_class"]] += 1
    return envelope(catalog, countries=sorted(countries.values(), key=lambda c: c["country_name"]))


@mcp.tool()
def sources_for_country(country: str) -> dict:
    """Everything the catalog lists for one country: dashboards, saved measurements and references.

    country: ISO 3166-1 alpha-3 code (for example DEU) or English name (for example Germany).
    """
    catalog = load_catalog()
    a3 = resolve_country(catalog, country)
    return envelope(catalog, country=a3, records=[r for r in catalog["records"] if r["country"] == a3])


@mcp.tool()
def latest_signals(country: str) -> dict:
    """Dated measurements saved for one country, each with its source URL, period and coverage.

    These are snapshots saved on the catalog's check date, not live values. An empty list means
    no measurement was saved for this country, not that nothing is circulating there.

    country: ISO 3166-1 alpha-3 code (for example USA) or English name.
    """
    catalog = load_catalog()
    a3 = resolve_country(catalog, country)
    records = [r for r in catalog["records"] if r["country"] == a3 and r["record_class"] == "measurement"]
    return envelope(catalog, country=a3, records=records)


if __name__ == "__main__":
    mcp.run()
