"""Static checks on the prototype pages for UX regressions found in the 2026-11-18 audit."""
import re
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"


def _view(html: str, view_id: str) -> str:
    start = html.index(f'id="{view_id}"')
    end = html.find('<section id="view-', start + 1)
    return html[start:end if end != -1 else None]


def test_share_outcome_is_visible_after_listening_card_hides():
    # Sharing hides #listening; the outcome must go to elements outside it.
    html = (APP / "app.html").read_text(encoding="utf-8")
    count_view = _view(html, "view-phone")
    listening = count_view[count_view.index('id="listening"'):]
    assert 'id="phoneNote"' in count_view and 'id="phoneError"' in count_view
    assert 'id="phoneNote"' not in listening and 'id="phoneError"' not in listening


def test_location_errors_shown_on_count_screen():
    js = (APP / "app.js").read_text(encoding="utf-8")
    body = js[js.index("function useMyLocation"):js.index('$("useLocation")')]
    assert '$("phoneError")' in body and '$("mapError")' not in body


def test_copy_names_existing_tabs():
    html = (APP / "app.html").read_text(encoding="utf-8")
    js = (APP / "app.js").read_text(encoding="utf-8")
    tabs = set(re.findall(r'class="tab[^"]*" data-view="\w+">([^<]+)<', html))
    quoted_tabs = re.findall(r'on the \\?"([^"\\]+)\\?" tab', js)
    assert quoted_tabs, "expected the empty-state copy to name a tab"
    for name in quoted_tabs:
        assert name in tabs, f"copy refers to a tab that does not exist: {name}"


def test_legend_text_is_one_flex_item():
    # Legend rows are flex containers; bare text next to <b> splits into columns.
    html = (APP / "app.html").read_text(encoding="utf-8")
    rows = re.findall(r"<li><span class=\"dot [^\"]+\"></span>(.*?)</li>", html)
    assert rows
    for li in rows:
        assert li.startswith("<span>") and li.endswith("</span>"), li


def test_uae_sources_are_honest_and_linked():
    import json
    data = json.loads((APP / "data" / "uae_monitors.json").read_text(encoding="utf-8"))
    for item in data["monitors"] + data["projects"]:
        assert item["url"].startswith("https://"), item["name"]
        text = json.dumps(item, ensure_ascii=False)
        assert "–" not in text and "—" not in text, item["name"]
    # no UAE source was found publishing surveillance data; the page must not imply one
    assert not any(m["status"] == "confirmed" for m in data["monitors"])
    html = (APP / "index.html").read_text(encoding="utf-8")
    assert html.index('id="uae"') < html.index('id="monitors"'), "UAE block comes before the EU block"


def test_asset_version_matches_service_worker_cache():
    # Cloudflare caches styles and scripts by URL; the ?v= number must move with every deploy,
    # and it is tied to the service-worker cache name so one bump covers both.
    sw = (APP / "sw.js").read_text(encoding="utf-8")
    version = re.search(r'const CACHE = "virufy-v(\d+)"', sw).group(1)
    for page in ("index.html", "app.html"):
        html = (APP / page).read_text(encoding="utf-8")
        refs = re.findall(r'(?:href|src)="(styles\.css|landing\.js|app\.js)(\?v=(\d+))?"', html)
        assert refs, page
        for name, _, v in refs:
            assert v == version, f"{page}: {name} has ?v={v or 'none'}, service worker is v{version}"


def test_scripts_parse_as_es_modules():
    # `node --check file.js` can pass a file that fails as an ES module in the browser
    # (an extra brace broke app.js on 2026-11-18); check the way the browser loads it.
    import shutil
    import subprocess
    import pytest
    node = shutil.which("node")
    if not node:
        pytest.skip("node is not installed")
    for name in ("app.js", "landing.js", "sw.js"):
        src = (APP / name).read_text(encoding="utf-8")
        res = subprocess.run([node, "--input-type=module", "--check"], input=src, text=True,
                             capture_output=True, encoding="utf-8")
        assert res.returncode == 0, f"{name}: {res.stderr.strip().splitlines()[-1] if res.stderr else ''}"
