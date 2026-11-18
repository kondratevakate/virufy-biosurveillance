// Map of public infectious-disease monitors in the EU/EEA. The outline is bundled
// (Natural Earth, public domain): no map tiles are requested from third parties.
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function detail(country, monitors) {
  const list = monitors.national[country.a3];
  if (list) {
    return `<h3>${esc(country.name)}</h3><ul class="news">${list.map((m) =>
      `<li><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.name)} ↗</a><br><span class="small">${esc(m.signal)} · ${esc(m.pathogens)}</span></li>`).join("")}</ul>`;
  }
  if (monitors.not_confirmed.includes(country.a3)) {
    return `<h3>${esc(country.name)}</h3><p class="small">A public monitor is listed by the EU or WHO, but we could not open and confirm it on ${esc(monitors.checked)}.</p>`;
  }
  if (monitors.not_checked.includes(country.a3)) {
    return `<h3>${esc(country.name)}</h3><p class="small">Not checked yet.</p>`;
  }
  return `<h3>${esc(country.name)}</h3><p class="small">Outside the EU and EEA; not part of this list.</p>`;
}

async function renderMonitorMap() {
  const box = $("monitorMap");
  try {
    const [geo, monitors] = await Promise.all([getJson("data/europe.json"), getJson("data/monitors.json")]);
    const [lon0, lat0, lon1, lat1] = geo.bounds, k = 14, c = Math.cos((52 * Math.PI) / 180);
    const X = (lon) => (lon - lon0) * c * k, Y = (lat) => (lat1 - lat) * k;
    const W = X(lon1), H = Y(lat0);
    const status = (a3) => (monitors.national[a3] ? "ok" : monitors.not_confirmed.includes(a3) ? "unconfirmed"
      : monitors.not_checked.includes(a3) ? "unchecked" : "outside");
    const fill = { ok: "#000000", unconfirmed: "url(#hatch)", unchecked: "#ffffff", outside: "#f5f5f5" };
    const paths = geo.countries.map((ct) => {
      const st = status(ct.a3);
      const d = ct.rings.map((r) => `M${r.map(([lo, la]) => `${X(lo).toFixed(1)},${Y(la).toFixed(1)}`).join("L")}Z`).join("");
      return `<path data-a3="${esc(ct.a3)}" d="${d}" fill="${fill[st]}" stroke="${st === "outside" ? "#bdbdbd" : "#000"}" stroke-width="0.6"><title>${esc(ct.name)}</title></path>`;
    }).join("");
    const counts = geo.countries.filter((ct) => monitors.national[ct.a3]).map((ct) =>
      `<text x="${X(ct.label[0]).toFixed(1)}" y="${Y(ct.label[1]).toFixed(1)}" font-size="11" font-family="Space Mono, monospace" fill="#fff" text-anchor="middle" dominant-baseline="middle" pointer-events="none">${monitors.national[ct.a3].length}</text>`).join("");
    box.innerHTML = `<svg viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" role="img" aria-label="Map of public monitors in the EU and EEA" style="height:auto">
      <defs><pattern id="hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="#fff"/><line x1="0" y1="0" x2="0" y2="5" stroke="#000" stroke-width="1"/></pattern></defs>
      ${paths}${counts}</svg>`;
    const byA3 = Object.fromEntries(geo.countries.map((ct) => [ct.a3, ct]));
    box.querySelector("svg").addEventListener("click", (ev) => {
      const a3 = ev.target.getAttribute && ev.target.getAttribute("data-a3");
      if (a3 && byA3[a3]) $("monitorDetail").innerHTML = detail(byA3[a3], monitors);
    });
  } catch (e) {
    box.innerHTML = `<div class="card error">The map could not be loaded (${esc(e.message || e)}). The full list is below.</div>`;
  }
}

renderMonitorMap();
