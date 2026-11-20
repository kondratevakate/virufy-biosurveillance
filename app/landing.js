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

// Map crop: the EU and EEA from Iceland to Cyprus; Russia and North Africa are cut off.
const CROP = { lon0: -25, lon1: 35, lat0: 34, lat1: 71.5 };

async function renderMonitorMap() {
  const box = $("monitorMap");
  try {
    const [geo, monitors] = await Promise.all([getJson("data/europe.json"), getJson("data/monitors.json")]);
    const { lon0, lon1, lat0, lat1 } = CROP, k = 14, c = Math.cos((52 * Math.PI) / 180);
    const X = (lon) => (lon - lon0) * c * k, Y = (lat) => (lat1 - lat) * k;
    const W = X(lon1), H = Y(lat0);
    const status = (a3) => (monitors.national[a3] ? "ok" : monitors.not_confirmed.includes(a3) ? "unconfirmed"
      : monitors.not_checked.includes(a3) ? "unchecked" : "outside");
    const paths = geo.countries.map((ct) => {
      const d = ct.rings.map((r) => `M${r.map(([lo, la]) => `${X(lo).toFixed(1)},${Y(la).toFixed(1)}`).join("L")}Z`).join("");
      return `<path data-a3="${esc(ct.a3)}" class="st-${status(ct.a3)}" d="${d}"><title>${esc(ct.name)}</title></path>`;
    }).join("");
    box.innerHTML = `<svg viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" role="img" aria-label="Map of public monitors in the EU and EEA">
      <defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="#fff"/><line x1="0" y1="0" x2="0" y2="4" stroke="#000" stroke-width="0.9"/></pattern></defs>
      <g class="countries">${paths}</g><g class="sel"></g></svg>`;

    const byA3 = Object.fromEntries(geo.countries.map((ct) => [ct.a3, ct]));
    const svg = box.querySelector("svg"), selLayer = svg.querySelector(".sel");
    const select = (a3) => {
      if (!byA3[a3]) return;
      $("monitorDetail").innerHTML = detail(byA3[a3], monitors);
      $("monitorDetail").classList.remove("hidden");
      // draw the selected outline on top so its border is not hidden by neighbours
      const src = svg.querySelector(`.countries path[data-a3="${a3}"]`);
      svg.querySelectorAll(".is-selected").forEach((el) => el.classList.remove("is-selected"));
      src?.classList.add("is-selected");
      selLayer.innerHTML = src ? `<path class="selected" d="${src.getAttribute("d")}"/>` : "";
      document.querySelectorAll("#countryChips button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.a3 === a3)));
    };
    svg.addEventListener("click", (ev) => select(ev.target.getAttribute && ev.target.getAttribute("data-a3")));

    // the same countries as buttons: works with a keyboard and on small screens
    const confirmed = Object.keys(monitors.national).filter((a3) => byA3[a3])
      .sort((a, b) => byA3[a].name.localeCompare(byA3[b].name));
    $("countryChips").innerHTML = confirmed.map((a3) =>
      `<button type="button" data-a3="${esc(a3)}" aria-pressed="false">${esc(byA3[a3].name)} <span class="mono">${monitors.national[a3].length}</span></button>`).join("");
    $("countryChips").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) select(b.dataset.a3); });
    $("nOk").textContent = confirmed.length;
    $("nUnconfirmed").textContent = monitors.not_confirmed.length;
    $("nUnchecked").textContent = monitors.not_checked.length;
  } catch (e) {
    box.innerHTML = `<div class="card error">The map could not be loaded (${esc(e.message || e)}). The full list is below.</div>`;
  }
}

// ---------- UAE: public monitors by emirate, and research projects ----------
// Emirates come from the bundled Natural Earth outline (data/uae.json); monitors and
// projects from data/uae_monitors.json, every entry opened and checked on its "checked" date.
function uaeDetail(item) {
  return `<h3>${esc(item.name)}</h3><p class="small">${esc(item.operator)} · ${esc(item.where)}</p>
    <p>${esc(item.text)}</p><p><a href="${esc(item.url)}" target="_blank" rel="noopener">Open the source ↗</a></p>`;
}

async function renderUaeMap() {
  const box = $("uaeMonitorMap");
  try {
    const [geo, data] = await Promise.all([getJson("data/uae.json"), getJson("data/uae_monitors.json")]);
    const [lon0, lat0, lon1, lat1] = geo.bounds, k = 120, c = Math.cos((24.3 * Math.PI) / 180), pad = 8;
    const X = (lon) => pad + (lon - lon0) * c * k, Y = (lat) => pad + (lat1 - lat) * k;
    const W = X(lon1) + pad, H = Y(lat0) + pad;
    const items = [...data.monitors, ...data.projects];
    // an emirate is black when a monitor there publishes data, hatched when it is described only
    const level = (name) => {
      const here = data.monitors.filter((m) => m.emirate === name);
      return here.some((m) => m.status === "confirmed") ? "ok" : here.length ? "unconfirmed" : "unchecked";
    };
    const paths = geo.emirates.map((e) => {
      const d = e.rings.map((r) => `M${r.map(([lo, la]) => `${X(lo).toFixed(1)},${Y(la).toFixed(1)}`).join("L")}Z`).join("");
      return `<path class="st-${e.name ? level(e.name) : "unchecked"}" d="${d}"><title>${esc(e.name || "UAE")}</title></path>`;
    }).join("");
    // studies and projects as numbered circles; entries at the same place are stacked
    const seen = {};
    const marks = data.projects.map((p, i) => {
      const key = `${p.lat},${p.lon}`, n = (seen[key] = (seen[key] || 0) + 1) - 1;
      const x = X(p.lon) + n * 22, y = Y(p.lat);
      return `<g class="project" data-i="${data.monitors.length + i}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9"/>
        <text x="${x.toFixed(1)}" y="${(y + 0.5).toFixed(1)}">${i + 1}</text><title>${esc(p.name)}</title></g>`;
    }).join("");
    box.innerHTML = `<svg viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" role="img" aria-label="Map of public monitors and projects in the UAE">
      <defs><pattern id="hatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="#fff"/><line x1="0" y1="0" x2="0" y2="4" stroke="#000" stroke-width="0.9"/></pattern></defs>
      ${paths}${marks}</svg>`;
    $("uaeChips").innerHTML = items.map((m, i) =>
      `<button type="button" data-i="${i}" aria-pressed="false">${i >= data.monitors.length ? `<span class="num">${i - data.monitors.length + 1}</span>` : ""}${esc(m.short || m.name)}</button>`).join("");
    const select = (i) => {
      if (!items[i]) return;
      $("uaeDetail").innerHTML = uaeDetail(items[i]);
      $("uaeDetail").classList.remove("hidden");
      document.querySelectorAll("#uaeChips button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.i === String(i))));
    };
    $("uaeChips").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) select(+b.dataset.i); });
    box.querySelector("svg").addEventListener("click", (ev) => { const g = ev.target.closest(".project"); if (g) select(+g.dataset.i); });
    $("uaeChecked").textContent = data.checked_label;
    $("uaeNBodies").textContent = data.monitors.length;
    $("uaeNStudies").textContent = data.projects.length;
    $("uaeNData").textContent = data.monitors.filter((m) => m.status === "confirmed").length;
  } catch (e) {
    box.innerHTML = `<div class="card error">The UAE map could not be loaded (${esc(e.message || e)}).</div>`;
  }
}
renderUaeMap();

// The map data (about 30 KB compressed) is fetched only when the map comes near the screen,
// so it does not compete with the first screen.
const mapBox = $("monitorMap");
let mapStarted = false;
const startMap = () => { if (!mapStarted) { mapStarted = true; renderMonitorMap(); } };
if ("IntersectionObserver" in window) {
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { io.disconnect(); startMap(); }
  }, { rootMargin: "800px 0px" });
  io.observe(mapBox);
  // fallback: load it anyway shortly after the page has loaded
  window.addEventListener("load", () => setTimeout(startMap, 3000));
} else {
  startMap();
}

// Static hero preview: the same outline, status precedence and source snapshots as the app.
// Keep this separate from app.js so the landing never downloads the audio runtime.
async function renderHeroWorld() {
  try {
    const [geo, sig] = await Promise.all([getJson("data/world.json"), getJson("data/world_signals.json")]);
    const dash = sig.layers.dashboards, resp = sig.layers.respiratory;
    const status = (a3) => resp[a3]?.status === "live" ? "signal" : dash[a3]?.status || resp[a3]?.status || "none";
    const X = (lon) => (lon + 170) * 3, Y = (lat) => (84 - lat) * 3;
    const paths = geo.countries.map((c) => {
      const d = c.rings.map((r) => `M${r.map(([lo, la]) => `${X(lo).toFixed(1)},${Y(la).toFixed(1)}`).join("L")}Z`).join("");
      return `<path class="w-${status(c.a3)}" d="${d}"/>`;
    }).join("");
    $("heroWorld").innerHTML = `<svg viewBox="0 0 1050 423" role="img" aria-label="World map of public source availability, not disease burden">
      <defs><pattern id="heroHatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="white"/><line x1="0" y1="0" x2="0" y2="4" stroke="black"/></pattern></defs>${paths}</svg>`;
    $("heroSourceDate").textContent = `Source list checked ${sig.checked} · Natural Earth outline`;
  } catch {
    // The ordinary app link and explanatory caption remain usable when data cannot load.
    $("heroWorld").innerHTML = '<p class="small">Map preview unavailable. Open the prototype to explore the sources.</p>';
  }
}
renderHeroWorld();
