"""Catalog format, builder and MCP server."""
import asyncio
import importlib.util
import json
import sys
from pathlib import Path

import jsonschema
import pytest

REPO = Path(__file__).resolve().parents[1]
CATALOG_DIR = REPO / "catalog"


def load_module(name: str):
    spec = importlib.util.spec_from_file_location(name, CATALOG_DIR / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def catalog():
    return json.loads((CATALOG_DIR / "catalog.json").read_text(encoding="utf-8"))


def test_catalog_matches_schema_and_builder(catalog):
    schema = json.loads((CATALOG_DIR / "schema.json").read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator.check_schema(schema)
    jsonschema.validate(catalog, schema, format_checker=jsonschema.FormatChecker())
    # the committed file is exactly what the builder produces from the verified source list
    assert load_module("build_catalog").build(catalog["catalog_version"]) == catalog


def test_records_are_sourced_dated_and_unique(catalog):
    ids = [r["id"] for r in catalog["records"]]
    assert len(ids) == len(set(ids))
    for r in catalog["records"]:
        assert r["observed"].strip(), r["id"]
        assert r["url"] or r["status"] == "listed_unconfirmed", r["id"]
        assert (r["record_class"] == "reference") == (r["status"] == "no_public_data"), r["id"]
        text = json.dumps(r, ensure_ascii=False).lower()
        assert "synthetic" not in text and "simulat" not in text, r["id"]


def test_builder_requires_an_explicit_version():
    import subprocess
    res = subprocess.run([sys.executable, "-I", str(CATALOG_DIR / "build_catalog.py")], capture_output=True, text=True)
    assert res.returncode != 0 and "--catalog-version" in res.stderr


def test_server_tools_answer_from_the_catalog(catalog):
    server = load_module("mcp_server")
    listed = server.list_countries()
    assert listed["note"] == catalog["note"] and listed["catalog_version"] == catalog["catalog_version"]
    assert {c["country"] for c in listed["countries"]} == {r["country"] for r in catalog["records"]}
    usa = server.latest_signals("usa")
    assert usa["country"] == "USA" and usa["records"]
    assert all(r["record_class"] == "measurement" and r["url"] for r in usa["records"])
    assert server.sources_for_country("Germany")["country"] == "DEU"
    assert server.latest_signals("AUT")["records"] == []  # a dashboard exists, no measurement saved
    for bad in ("", "Atlantis", "x" * 61):
        with pytest.raises(ValueError):
            server.sources_for_country(bad)


def test_server_speaks_mcp_over_stdio():
    # The MCP SDK needs anyio 4.5 or newer; with an older anyio it fails inside the SDK, not in our code.
    # Run this test in the environment built from catalog/requirements.txt.
    from importlib.metadata import version
    anyio_version = tuple(int(part) for part in version("anyio").split(".")[:2])
    if anyio_version < (4, 5):
        pytest.skip(f"anyio {version('anyio')} is too old for the MCP SDK; use the catalog/requirements.txt environment")
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    async def run():
        params = StdioServerParameters(command=sys.executable, args=[str(CATALOG_DIR / "mcp_server.py")])
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools = {t.name for t in (await session.list_tools()).tools}
                result = await session.call_tool("latest_signals", {"country": "GBR"})
                failure = await session.call_tool("latest_signals", {"country": "Atlantis"})
                return tools, result, failure

    tools, result, failure = asyncio.run(asyncio.wait_for(run(), timeout=60))
    assert tools == {"list_countries", "sources_for_country", "latest_signals"}
    assert not result.isError
    payload = json.loads(result.content[0].text)
    assert payload["country"] == "GBR" and any("England" in r["detail"] for r in payload["records"])
    assert failure.isError and "partial" in failure.content[0].text


def test_site_serves_the_same_catalog_as_the_repository():
    # The site links to a copy of the catalog; it must never drift from the built one.
    app_data = REPO / "app" / "data"
    # compared as parsed JSON: git may check the two copies out with different line endings
    load = lambda path: json.loads(path.read_text(encoding="utf-8"))
    assert load(app_data / "catalog.json") == load(CATALOG_DIR / "catalog.json")
    assert load(app_data / "catalog.schema.json") == load(CATALOG_DIR / "schema.json")
    html = (REPO / "app" / "app.html").read_text(encoding="utf-8")
    cat = json.loads((app_data / "catalog.json").read_text(encoding="utf-8"))
    assert f"{len(cat['records'])} records for {len({r['country'] for r in cat['records']})} countries" in html


def test_dcat_export_carries_every_record_and_matches_the_site_copy():
    dcat = load_module("build_dcat").build()
    cat = json.loads((CATALOG_DIR / "catalog.json").read_text(encoding="utf-8"))
    assert json.loads((CATALOG_DIR / "catalog.dcat.jsonld").read_text(encoding="utf-8")) == dcat
    assert json.loads((REPO / "app" / "data" / "catalog.dcat.jsonld").read_text(encoding="utf-8")) == dcat
    assert dcat["@type"] == "dcat:Catalog" and dcat["dcat:version"] == cat["catalog_version"]
    by_id = {d["dcterms:identifier"]: d for d in dcat["dcat:dataset"]}
    assert set(by_id) == {r["id"] for r in cat["records"]}
    for r in cat["records"]:
        d = by_id[r["id"]]
        assert d["dcterms:spatial"]["@id"].endswith("/" + r["country"])
        assert ("dcat:landingPage" in d) == bool(r["url"])
        assert d["vb:status"] == r["status"] and d["vb:observed"] == r["observed"]
