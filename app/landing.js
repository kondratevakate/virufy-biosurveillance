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
