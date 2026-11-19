// Virufy biosurveillance prototype: on-device cough counting and a zone dashboard.
// Audio never leaves the device; only counts per 15-minute bin and a zone code are shared.
import { AudioClassifier, FilesetResolver } from "./vendor/tasks-audio/audio_bundle.mjs";

const MODEL_PATH = "./models/yamnet.tflite";
const WASM_PATH = "./vendor/tasks-audio/wasm";
// Cough score threshold. 0.5 gave sensitivity 0.825 at 3.3 false positives per hour of
// non-cough sound on ESC-50 (exploratory, chosen on the same data; see eval/results).
const COUGH_THRESHOLD = 0.5;
const REFRACTORY_MS = 1000;     // one cough event per second at most
const BIN_MS = 15 * 60 * 1000;  // sharing granularity
const SESSION_SECONDS = 15 * 60; // one check-in listens for up to 15 minutes
const MIN_PARTICIPANTS = 10;    // small-cell suppression
const STORE_KEY = "virufy_shared_counts_v1";

// ---------- shared helpers ----------
const $ = (id) => document.getElementById(id);
// Escape every value that comes from storage or data files before it enters innerHTML.
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function showError(el, msg) { el.textContent = msg; el.classList.remove("hidden"); }
// A message on the Count screen that stays visible after the listening card is hidden.
function showNote(msg) { const el = $("phoneNote"); el.textContent = msg; el.classList.toggle("hidden", !msg); }
function loadShared() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); }
  catch { return []; }
}
function saveShared(list) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); return true; }
  catch { return false; }
}

function sparkline(values, flags, { max } = {}) {
  const w = 280, h = 70, pad = 4;
  const vals = values.map((v) => (v == null ? null : v));
  const top = max ?? Math.max(...vals.filter((v) => v != null), 1e-9);
  const x = (i) => pad + (i * (w - 2 * pad)) / Math.max(vals.length - 1, 1);
  const y = (v) => h - pad - (v / top) * (h - 2 * pad);
  let d = "";
  vals.forEach((v, i) => { if (v != null) d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; });
  const dots = vals.map((v, i) => (flags[i]?.flag && v != null)
    ? `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="#ef4444"/>` : "").join("");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">
    <path d="${d}" fill="none" stroke="#000000" stroke-width="2"/>${dots}</svg>`;
}

// ---------- one scrolling page: the tabs are anchors ----------
// Every section is on the page; a tab scrolls to it, and the tab of the section on screen is highlighted.
// Heavy parts (detector, maps, dashboard, evidence) load when their section comes near the screen.
const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
function scrollToView(view) {
  document.getElementById(`view-${view}`)?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}
const loaders = {
  world: () => renderWorld(),
  phone: () => warmUpDetector(),
  dashboard: () => { renderDashboard(); renderMap("network"); },
  about: () => renderAbout(),
};
const loaded = new Set();
function ensureLoaded(view) {
  if (loaded.has(view) || !loaders[view]) return;
  loaded.add(view);
  loaders[view]();
}
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  ensureLoaded(b.dataset.view);
  scrollToView(b.dataset.view);
}));
// Buttons with data-go jump to a section, the same as tapping its tab.
function go(view) { ensureLoaded(view); scrollToView(view); }
document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => go(b.dataset.go)));

if ("IntersectionObserver" in window) {
  // load a section shortly before it scrolls into view
  const near = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) ensureLoaded(e.target.id.replace("view-", ""));
  }), { rootMargin: "600px 0px" });
  // highlight the tab of the section that crosses the upper third of the screen
  const spy = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (!e.isIntersecting) return;
    const view = e.target.id.replace("view-", "");
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  }), { rootMargin: "-30% 0px -65% 0px" });
  document.querySelectorAll(".view").forEach((v) => { near.observe(v); spy.observe(v); });
} else {
  Object.keys(loaders).forEach(ensureLoaded);
}

// ---------- haptics and motion ----------
// A short vibration where the phone supports it (Android Chrome; iOS Safari has no Vibration API).
// Nothing happens when the user asked the system for reduced motion.
function buzz(pattern) {
  // browsers allow vibration only after the user has touched the page
  if (reduceMotion || navigator.userActivation?.hasBeenActive === false) return;
  try { navigator.vibrate?.(pattern); } catch { /* not supported */ }
}
function bump(el) {
  if (reduceMotion || !el) return;
  el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
}

// ---------- participant: on-device counting ----------
let classifier = null, audioCtx = null, stream = null, node = null;
let total = 0, lastEventAt = 0, binStart = 0, binCount = 0, binSeconds = 0, buffer = [], bufferLen = 0;
let listenedSeconds = 0, placeName = "";
const bins = []; // {zone, bin_start, coughs}

// One classifier for the page, created once: repeated taps must not load the 10 MB model again.
let classifierPromise = null;
function loadClassifier() {
  if (!classifierPromise) {
    classifierPromise = FilesetResolver.forAudioTasks(WASM_PATH)
      .then((fileset) => AudioClassifier.createFromOptions(fileset, { baseOptions: { modelAssetPath: MODEL_PATH }, maxResults: -1 }))
      .catch((e) => { classifierPromise = null; throw e; });
  }
  return classifierPromise;
}

// Start downloading the detector (model and runtime, about 6 MB compressed) as soon as the Count
// screen opens, so "Start" does not wait for it. A failure here is shown, and Start retries.
function warmUpDetector() {
  const el = $("modelState");
  if (classifier) return;
  el.textContent = "Cough detector: loading (about 6 MB the first time)…";
  loadClassifier()
    .then((c) => { classifier = c; el.textContent = "Cough detector: ready. It runs on this phone."; })
    .catch((e) => { el.textContent = `Cough detector: could not load (${e.message || e}). Start will try again.`; });
}

const SILENCE_RMS = 0.01;  // seconds quieter than this are not sent to the model (saves the phone's CPU)
let starting = false;

async function startListening() {
  if (starting || node) return;  // ignore repeated taps while loading or listening
  const err = $("phoneError"), btn = $("start");
  err.classList.add("hidden"); showNote(""); $("recs").classList.add("hidden");
  if (!navigator.mediaDevices?.getUserMedia) {
    showError(err, "This browser cannot access the microphone. Open the page over HTTPS in Chrome or Safari.");
    return;
  }
  starting = true; btn.disabled = true;
  const fail = (msg) => { showError(err, msg); starting = false; btn.disabled = false; btn.textContent = "Start 15-minute check-in"; };
  // iOS only lets audio start from inside the tap, so the context is created before any waiting.
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
  catch (e) { fail(`Audio could not be started on this device (${e.message || e}).`); return; }
  btn.textContent = "Asking for the microphone…";
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } });
  } catch (e) {
    audioCtx.close(); audioCtx = null;
    fail("Microphone permission was refused, so nothing is being counted.");
    return;
  }
  btn.textContent = classifier ? "Starting…" : "Loading the cough detector…";
  try {
    classifier = await loadClassifier();
    $("modelState").textContent = "Cough detector: ready. It runs on this phone.";
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop()); stream = null; audioCtx.close(); audioCtx = null;
    fail(`The cough detector could not be loaded (${e.message || e}).`);
    return;
  }
  try { await audioCtx.resume(); } catch { /* already running */ }
  const src = audioCtx.createMediaStreamSource(stream);
  node = audioCtx.createScriptProcessor(4096, 1, 1);
  const zone = $("zone").value, rate = audioCtx.sampleRate;
  placeName = $("zone").selectedOptions[0]?.textContent || zone; listenedSeconds = 0; total = 0;
  $("count").textContent = "0"; $("perHour").textContent = "…";
  $("timeLeft").textContent = "15:00"; $("progressBar").style.width = "0%"; bins.length = 0;
  binStart = Math.floor(Date.now() / BIN_MS) * BIN_MS;
  let busy = false;
  node.onaudioprocess = (ev) => {
    const chunk = new Float32Array(ev.inputBuffer.getChannelData(0));
    buffer.push(chunk); bufferLen += chunk.length;
    if (bufferLen < rate) return; // one decision per second of audio
    const second = new Float32Array(bufferLen);
    let off = 0, energy = 0;
    for (const c of buffer) { second.set(c, off); off += c.length; }
    buffer = []; bufferLen = 0;
    for (let i = 0; i < second.length; i += 1) energy += second[i] * second[i];
    if (Math.sqrt(energy / second.length) < SILENCE_RMS || busy) { onScore(0, zone); return; }
    busy = true;
    // run the model outside the audio callback so the page stays responsive
    setTimeout(() => {
      let score = 0;
      try {
        for (const r of classifier.classify(second, rate)) {
          const cat = r.classifications[0].categories.find((c) => c.categoryName === "Cough");
          if (cat) score = Math.max(score, cat.score);
        }
      } catch (e) {
        $("status").textContent = `Detector error: ${e.message || e}`;
      }
      second.fill(0); // the audio is discarded here
      busy = false;
      onScore(score, zone);
    }, 0);
  };
  src.connect(node); node.connect(audioCtx.destination);
  // live level bars: the analyser reads the same stream in memory, nothing is kept
  analyser = audioCtx.createAnalyser(); analyser.fftSize = 128; analyser.smoothingTimeConstant = 0.7;
  src.connect(analyser);
  startVisuals();
  starting = false; btn.disabled = false; btn.textContent = "Start 15-minute check-in";
  $("consent").classList.add("hidden");
  $("listening").classList.remove("hidden");
  buzz(20);
  $("status").textContent = `Listening at: ${placeName}. Audio stays on this phone.`;
}

function onScore(score, zone) {
  const now = Date.now();
  pushScore(score);
  const bin = Math.floor(now / BIN_MS) * BIN_MS;
  if (bin !== binStart) { bins.push(binRecord(zone)); binStart = bin; binCount = 0; binSeconds = 0; }
  binSeconds += 1; listenedSeconds += 1;
  const mm = Math.floor(listenedSeconds / 60), ss = String(listenedSeconds % 60).padStart(2, "0");
  $("status").textContent = `Listening at: ${placeName} for ${mm}:${ss}. Audio stays on this phone.`;
  if (score >= COUGH_THRESHOLD && now - lastEventAt > REFRACTORY_MS) {
    lastEventAt = now; total += 1; binCount += 1;
    $("count").textContent = total;
    bump($("count")); buzz(40);
  }
  // countdown of the 15-minute check-in; at zero the counts are shared and the microphone goes off
  const left = Math.max(0, SESSION_SECONDS - listenedSeconds);
  $("timeLeft").textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  $("progressBar").style.width = `${Math.min(100, (100 * listenedSeconds) / SESSION_SECONDS).toFixed(1)}%`;
  if (left === 0 && node) { setTimeout(shareCounts, 0); return; }
  // coughs per listening hour for this spot check, shown once a minute of audio is in
  if (listenedSeconds >= 60) $("perHour").textContent = (total / (listenedSeconds / 3600)).toFixed(1);
}

// ---------- visuals while listening ----------
// An equalizer of the sound around the phone (frequency bands, drawn from memory, never stored)
// and one bar per second with the model's cough score; red bars were counted as coughs.
const EQ_BARS = 24, SCORE_BARS = 30;
let analyser = null, eqFrame = 0, eqEls = [], scoreEls = [];
const scores = [];
function startVisuals() {
  $("eq").innerHTML = Array.from({ length: EQ_BARS }, () => "<span></span>").join("");
  eqEls = [...$("eq").children];
  $("scoreBars").innerHTML = Array.from({ length: SCORE_BARS }, () => "<span></span>").join("")
    + `<i class="threshold" style="bottom:${COUGH_THRESHOLD * 100}%"></i>`;
  scoreEls = [...$("scoreBars").querySelectorAll("span")];
  scores.length = 0;
  const bins = new Uint8Array(analyser.frequencyBinCount);
  const draw = () => {
    if (!analyser) return;
    analyser.getByteFrequencyData(bins);
    // the lower two thirds of the spectrum hold speech and coughs; group them into bars
    const used = Math.floor(bins.length * 0.66), per = Math.max(1, Math.floor(used / EQ_BARS));
    eqEls.forEach((el, i) => {
      let m = 0;
      for (let k = i * per; k < (i + 1) * per; k += 1) m = Math.max(m, bins[k]);
      el.style.transform = `scaleY(${Math.max(0.04, m / 255).toFixed(3)})`;
    });
    eqFrame = requestAnimationFrame(draw);
  };
  eqFrame = requestAnimationFrame(draw);
}
function stopVisuals() {
  cancelAnimationFrame(eqFrame);
  try { analyser?.disconnect(); } catch { /* already gone */ }
  analyser = null;
}
function pushScore(score) {
  scores.push(score);
  if (scores.length > SCORE_BARS) scores.shift();
  const offset = SCORE_BARS - scores.length;
  scoreEls.forEach((el, i) => {
    const v = i >= offset ? scores[i - offset] : 0;
    el.style.height = `${Math.max(2, Math.round(v * 100))}%`;
    el.classList.toggle("hit", v >= COUGH_THRESHOLD);
  });
}

// What leaves the phone for one 15-minute bin: kind of place, a map cell of about 1 km, counts. No audio.
function binRecord(zone) {
  const place = loadPlace();
  return { zone, cell: place ? [place.lat, place.lon] : null, bin_start: new Date(binStart).toISOString(),
           coughs: binCount, listening_seconds: binSeconds };
}

function stopListening() {
  stopVisuals();
  try { node?.disconnect(); stream?.getTracks().forEach((t) => t.stop()); audioCtx?.close(); } catch { /* already stopped */ }
  node = null; stream = null; audioCtx = null; buffer = []; bufferLen = 0;
  $("status").textContent = "Stopped. The microphone is off.";
  $("listening").classList.add("hidden"); $("consent").classList.remove("hidden");
}

function shareCounts() {
  const zone = $("zone").value;
  const payload = [...bins, binRecord(zone)];
  $("payload").textContent = JSON.stringify(payload, null, 1);
  const ok = saveShared([...loadShared(), ...payload]);
  const coughs = payload.reduce((a, b) => a + b.coughs, 0);
  // a per-hour rate from under a minute of audio means little, so it is not shown
  const duration = listenedSeconds < 90 ? `${listenedSeconds} s` : `about ${Math.round(listenedSeconds / 60)} min`;
  const rate = listenedSeconds >= 60 ? `${(coughs / (listenedSeconds / 3600)).toFixed(1)} per hour` : "too short for a per-hour rate";
  bins.length = 0; binCount = 0; binSeconds = 0;
  stopListening();  // a check ends when it is added: the microphone goes off
  // The listening card is hidden now, so the result and what to do are shown on this screen.
  if (!ok) {
    showError($("phoneError"), "Could not store the counts on this device (storage is blocked); nothing was shared.");
    return;
  }
  const placed = Boolean(loadPlace());
  showNote(`Check finished: ${coughs} cough${coughs === 1 ? "" : "s"} in ${duration}, ${rate} (demo: kept on this phone). `
    + (placed ? "It is on the network map." : "No place was set, so it is not on the network map; set one in Step 1 before the next check."));
  $("recs").classList.remove("hidden");
  $("toNetwork").classList.toggle("hidden", !placed);
  $("consent").classList.add("hidden");
  buzz([30, 60, 30]);
  scrollToView("phone");
}

$("start").addEventListener("click", startListening);
// stopping without sharing drops this session's counts
$("stop").addEventListener("click", () => { bins.length = 0; binCount = 0; binSeconds = 0; stopListening(); });
$("share").addEventListener("click", shareCounts);
$("checkAgain").addEventListener("click", () => {
  showNote(""); $("recs").classList.add("hidden"); $("consent").classList.remove("hidden"); scrollToView("phone");
});

// ---------- dashboard ----------
// Synthetic zones: seeded so every judge sees the same series.
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; }; }
const ACTIONS = {
  "Airport arrivals hall": ["Increase ventilation and offer masks in the hall; notify port-of-entry health", "Port health officer"],
  "Worksite A": ["Check dust and heat exposure, rotate crews, offer testing to symptomatic workers", "Site occupational health lead"],
  "Labour accommodation B": ["Offer testing and isolation space; check ventilation", "Occupational health lead"],
  "District school cluster": ["Notify school health service; reinforce sick-day guidance", "District public health officer"],
  "Clinic waiting room": ["Separate respiratory patients in waiting area", "Clinic infection control lead"],
};
// Synthetic zones follow the model of the paper and of experiment E2:
// daily count Y ~ Poisson(load * weekday factor * (sensitivity * background * r + phi)),
// with r = 1.5 in the airport zone for the last 6 days (a synthetic outbreak). Detector error is set to
// the measured values: sensitivity from ESC-50, false alarms at the upper bound from experiment E1.
const BURN_DAYS = 56, SHOWN_DAYS = 28, OUTBREAK_RATIO = 1.5, DOW = [1, 1, 1, 1, 1, 0.8, 0.8];
function poisson(r, mu) {
  if (mu > 50) {  // normal approximation is enough for a demo series
    const u = Math.max(r(), 1e-12), v = r();
    return Math.max(0, Math.round(mu + Math.sqrt(mu) * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
  }
  let k = 0, p = 1; const L = Math.exp(-mu);
  do { k += 1; p *= r(); } while (p > L);
  return k - 1;
}
function syntheticZones(det) {
  const r = rng(42), days = BURN_DAYS + SHOWN_DAYS;
  const spec = [  // name, participants, person-hours per day, outbreak days at the end
    ["Airport arrivals hall", 140, 1000, 6, "Dubai", 25.25, 55.36], ["Worksite A", 60, 200, 0, "Jebel Ali", 25.01, 55.06],
    ["Labour accommodation B", 45, 200, 0, "Mussafah", 24.35, 54.5], ["District school cluster", 90, 1000, 0, "Al Ain", 24.21, 55.75],
    ["Clinic waiting room", 7, 50, 0, "Sharjah", 25.35, 55.4],
  ];
  return spec.map(([name, participants, load, outbreakDays, city, lat, lon]) => {
    const E = [], Y = [];
    for (let t = 0; t < days; t += 1) {
      const e = load * DOW[t % 7] * (0.85 + 0.3 * r());
      const ratio = outbreakDays && t >= days - outbreakDays ? OUTBREAK_RATIO : 1;
      E.push(e); Y.push(poisson(r, e * (det.sensitivity * det.background * ratio + det.phi)));
    }
    // baseline rate per weekday from the burn-in, then a bank of Poisson CUSUMs with the load as offset;
    // each member is scaled by its own alarm level and the largest scaled value is compared with the bank's level
    const rate = DOW.map((_, k) => {
      let y = 0, e = 0;
      for (let t = k; t < BURN_DAYS; t += 7) { y += Y[t]; e += E[t]; }
      return y / e;
    });
    const bank = det.bank_by_load[String(load)], h = bank.alarm;
    const S = det.ratios.map(() => 0), flags = [], vals = [], cusum = [];
    for (let t = BURN_DAYS; t < days; t += 1) {
      const mu0 = E[t] * rate[t % 7];
      let stat = 0;
      det.ratios.forEach((ratio, i) => {
        S[i] = Math.max(0, S[i] + Y[t] * Math.log(ratio) - mu0 * (ratio - 1));
        stat = Math.max(stat, S[i] / bank.levels[i]);
      });
      vals.push(Y[t] / E[t]); cusum.push(stat); flags.push({ flag: stat > h });
    }
    const firstAlarm = flags.findIndex((f) => f.flag);
    return { name, city, lat, lon, participants, load, vals, flags, cusum, h, baseline: rate.reduce((x, y) => x + y, 0) / 7,
             outbreakStart: outbreakDays ? SHOWN_DAYS - outbreakDays : -1, firstAlarm };
  });
}

let detection = null;
async function loadDetection() {
  if (detection) return detection;
  const res = await fetch("./data/detection.json");
  if (!res.ok) throw new Error(`detection settings: HTTP ${res.status}`);
  detection = await res.json();
  return detection;
}

let wastewater = null;
async function loadWastewater() {
  if (wastewater) return wastewater;
  const res = await fetch("./data/wastewater.json");
  if (!res.ok) throw new Error(`wastewater data: HTTP ${res.status}`);
  wastewater = await res.json();
  return wastewater;
}

async function renderDashboard() {
  let zones = [], zonesOk = true;
  try {
    zones = syntheticZones(await loadDetection());
  } catch (e) {
    zonesOk = false;
    showError($("dashError"), `Zone settings could not be loaded (${e.message || e}).`);
  }
  const alerts = [];
  $("zones").innerHTML = zones.map((z) => {
    if (z.participants < MIN_PARTICIPANTS) {
      return `<div class="card zone suppressed"><h4>${z.name}, ${z.city}</h4>
        <div class="meta">Hidden: ${z.participants} participants, below the minimum of ${MIN_PARTICIPANTS}.</div></div>`;
    }
    const last = z.vals.length - 1;
    if (z.flags[last].flag) alerts.push({ z });
    return `<div class="card zone"><h4>${z.name}, ${z.city}</h4>
      <div class="meta">${z.participants} participants · ${z.load} listening hours per day · last 28 days · today ${z.vals[last].toFixed(2)}</div>
      ${sparkline(z.vals, z.flags)}</div>`;
  }).join("");

  const shared = loadShared();
  if (shared.length) {
    const sum = shared.reduce((a, b) => a + (Number(b.coughs) || 0), 0);
    $("zones").innerHTML += `<div class="card zone"><h4>Your shared counts (this device)</h4>
      <div class="meta">${shared.length} bins · ${sum} coughs · zone ${esc(shared[shared.length - 1].zone)}</div></div>`;
  }

  let wwFlags = [];
  try {
    const ww = await loadWastewater();
    const country = $("wwCountry").value;
    const series = ww.series.filter((s) => s.country === country);
    $("wastewater").innerHTML = series.map((s) => {
      const recent = s.flags.slice(-4).some((f) => f.flag);
      if (recent) wwFlags.push(`${s.target} (${country})`);
      return `<div class="card ww"><h4>${esc(s.target)}</h4>
        <div class="meta">${esc(s.weeks[0])} to ${esc(s.weeks[s.weeks.length - 1])} · ${s.n.reduce((a, b) => a + b, 0)} samples ·
        ${Number(s.n_flagged_weeks)} flagged weeks</div>
        ${sparkline(s.positivity, s.flags, { max: 1 })}</div>`;
    }).join("");
  } catch (e) {
    $("wastewater").innerHTML = "";
    showError($("dashError"), `Wastewater data could not be loaded (${e.message || e}).`);
  }

  $("alerts").innerHTML = alerts.length ? alerts.map(({ z }) => {
    const [action, role] = ACTIONS[z.name] || ["Review the zone", "Public health officer"];
    const last = z.vals.length - 1;
    // The zones are synthetic and the wastewater series are real data from 2024 to 2025,
    // so the two are reported side by side, never as the same period.
    const ww = wwFlags.length
      ? `Second signal (real data, different period): the last 4 weeks of the aviation wastewater series were flagged for ${wwFlags.map(esc).join(", ")}.`
      : "Second signal (real data, different period): no flag in the last 4 weeks of the aviation wastewater series.";
    const delay = z.outbreakStart >= 0 && z.firstAlarm >= z.outbreakStart
      ? ` The synthetic rise of 50% began ${last - z.outbreakStart + 1} days ago and was flagged on day ${z.firstAlarm - z.outbreakStart + 1}.` : "";
    return `<div class="card alert"><b>${z.name}, ${z.city}</b>: detections ${z.vals[last].toFixed(2)} per listening hour against a baseline of
      ${z.baseline.toFixed(2)}. The running sum of coughs above the baseline (CUSUM) is above its alarm level, which is set for about
      one false alarm in 180 days.${delay}<br>
      ${ww}<br>Suggested action: ${action}. Responsible: ${role}. A person decides; the system only recommends.</div>`;
  }).join("") : zonesOk ? `<div class="card muted">No zone is above its alarm level today.</div>`
    : `<div class="card muted">Alerts are unavailable because the zone settings did not load.</div>`;
}
$("wwCountry").addEventListener("change", renderDashboard);

async function renderAbout() {
  try {
    const res = await fetch("./data/esc50_summary.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = await res.json();
    const pct = (x) => `${(100 * x).toFixed(1)}%`;
    $("evalBox").innerHTML = `<table>
      <tr><td>ROC AUC</td><td>${s.roc_auc_all_clips.toFixed(3)}</td></tr>
      <tr><td>Sensitivity (cross-validated threshold)</td><td>${pct(s.sensitivity)} (95% CI ${pct(s.sensitivity_ci95[0])} to ${pct(s.sensitivity_ci95[1])})</td></tr>
      <tr><td>Specificity</td><td>${pct(s.specificity)} (95% CI ${pct(s.specificity_ci95[0])} to ${pct(s.specificity_ci95[1])})</td></tr>
      <tr><td>False alarms per hour of non-cough sound</td><td>${s.false_positives_per_hour.toFixed(1)}</td></tr>
      <tr><td>Most confused with</td><td>${Object.entries(s.top_false_positive_classes).slice(0, 3).map(([k, v]) => `${esc(k)} (${Number(v)})`).join(", ")}</td></tr>
      </table><p class="small">The app uses a stricter threshold (0.5) to cut false alarms; on the same data that gives
      sensitivity 82.5% at 3.3 false alarms per hour. That choice was made on the same clips, so it is exploratory.</p>`;
  } catch (e) {
    $("evalBox").textContent = `Evaluation summary could not be loaded (${e.message || e}).`;
  }
  try {
    const res = await fetch("./data/experiments.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = await res.json();
    $("expBox").innerHTML = items.map((x) => `<p><b>${esc(x.title)}</b><br>${esc(x.text)}</p>`).join("");
  } catch (e) {
    $("expBox").textContent = `Experiment summary could not be loaded (${e.message || e}).`;
  }
}

// ---------- world map of real public signals ----------
// Outline: Natural Earth 1:110m (public domain), bundled; no map tiles are requested.
// Signals: data/world_signals.json, built by eval/build_world_signals.py from verified public
// sources only. A country without an entry is "no public signal listed", never zero.
const WORLD_STATUS_LABEL = {
  live: "Public signal we opened", listed: "Listed by the EU or WHO, not confirmed by us",
  past: "Real data from a past period only", studies: "Published studies, no running data",
};
function worldDetail(name, entry) {
  if (!entry) return `<h3>${esc(name)}</h3><p class="small">No public signal listed here. That does not mean the country has none.</p>`;
  return `<h3>${esc(name)}</h3><p class="mono kicker">${esc(WORLD_STATUS_LABEL[entry.status] || "")}</p><ul class="news">${entry.items.map((it) =>
    `<li><b>${esc(it.name)}</b><br><span class="small">${esc(it.kind)} · ${esc(it.detail)}</span><br>
     <span class="mono small">${esc(it.date)}</span>${it.url ? ` · <a href="${esc(it.url)}" target="_blank" rel="noopener">source ↗</a>` : ""}</li>`).join("")}</ul>`;
}
async function renderWorld() {
  const box = $("worldMap");
  try {
    const [geo, sig] = await Promise.all([
      fetch("./data/world.json").then((r) => { if (!r.ok) throw new Error(`world outline: HTTP ${r.status}`); return r.json(); }),
      fetch("./data/world_signals.json").then((r) => { if (!r.ok) throw new Error(`world signals: HTTP ${r.status}`); return r.json(); }),
    ]);
    const lon0 = -170, lon1 = 180, lat0 = -57, lat1 = 84, k = 3;
    const X = (lon) => (lon - lon0) * k, Y = (lat) => (lat1 - lat) * k;
    const W = X(lon1), H = Y(lat0);
    const byA3 = Object.fromEntries(geo.countries.map((c) => [c.a3, c]));
    const paths = geo.countries.map((c) => {
      const st = sig.countries[c.a3]?.status || "none";
      const d = c.rings.map((r) => `M${r.map(([lo, la]) => `${X(lo).toFixed(1)},${Y(la).toFixed(1)}`).join("L")}Z`).join("");
      return `<path data-a3="${esc(c.a3)}" class="w-${st}" d="${d}"><title>${esc(c.name)}</title></path>`;
    }).join("");
    box.innerHTML = `<svg viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" role="img" aria-label="World map of public respiratory signals">
      <defs><pattern id="hatchW" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="4" height="4" fill="#fff"/><line x1="0" y1="0" x2="0" y2="4" stroke="#000" stroke-width="1"/></pattern></defs>
      <g class="countries">${paths}</g><g class="sel"></g></svg>`;
    const svg = box.querySelector("svg"), sel = svg.querySelector(".sel");
    const select = (a3) => {
      const c = byA3[a3];
      if (!c) return;
      $("worldDetail").innerHTML = worldDetail(c.name, sig.countries[a3]);
      $("worldDetail").classList.remove("hidden");
      const src = svg.querySelector(`.countries path[data-a3="${a3}"]`);
      sel.innerHTML = src ? `<path class="selected" d="${src.getAttribute("d")}"/>` : "";
      document.querySelectorAll("#worldChips button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.a3 === a3)));
      buzz(10);
    };
    svg.addEventListener("click", (ev) => select(ev.target.getAttribute && ev.target.getAttribute("data-a3")));
    const withData = Object.entries(sig.countries).filter(([a3, e]) => byA3[a3] && e.status !== "listed")
      .sort((a, b) => byA3[a[0]].name.localeCompare(byA3[b[0]].name));
    $("worldChips").innerHTML = withData.map(([a3]) =>
      `<button type="button" data-a3="${esc(a3)}" aria-pressed="false">${esc(byA3[a3].name)}</button>`).join("");
    $("worldChips").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) select(b.dataset.a3); });
    const count = (st) => Object.values(sig.countries).filter((e) => e.status === st).length;
    $("wLive").textContent = count("live"); $("wListed").textContent = count("listed"); $("wPast").textContent = count("past");
    $("worldChecked").textContent = new Date(`${sig.checked}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }).toUpperCase();
    $("euLevel").innerHTML = sig.eu_level.map((m) =>
      `<li><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.name)} ↗</a> <span class="small">${esc(m.operator)} · ${esc(m.detail)}</span></li>`).join("");
  } catch (e) {
    box.innerHTML = `<div class="card error">The world map could not be loaded (${esc(e.message || e)}).</div>`;
  }
}

// ---------- map of the UAE ----------
// The outline is bundled with the app (Natural Earth, public domain): no map tiles are requested,
// so no third party learns where the user is looking. A place is stored as a cell of 0.01 degrees
// (about 1 km), on this device only, and only after the user taps the map or allows location.
const PLACE_KEY = "virufy_place_v1", CELL = 0.01, COS_LAT = Math.cos((24.3 * Math.PI) / 180), MAP_SCALE = 150;
const roundCell = (v) => Math.round(v / CELL) * CELL;
function loadPlace() {
  try { return JSON.parse(localStorage.getItem(PLACE_KEY) || "null"); } catch { return null; }
}
function savePlace(lat, lon) {
  const place = { lat: +roundCell(lat).toFixed(2), lon: +roundCell(lon).toFixed(2) };
  try { localStorage.setItem(PLACE_KEY, JSON.stringify(place)); } catch { /* storage blocked: the place is kept for this page only */ }
  showPlace(place);
  return place;
}
function showPlace(place) {
  const text = place ? `Place set: cell ${place.lat.toFixed(2)}, ${place.lon.toFixed(2)} (about 1 km)` : "No place set yet.";
  $("placeLabelPhone").textContent = text;
}

let uae = null;
async function loadUae() {
  if (uae) return uae;
  const res = await fetch("./data/uae.json");
  if (!res.ok) throw new Error(`map outline: HTTP ${res.status}`);
  uae = await res.json();
  return uae;
}
function rateColor(perHour) {  // detections per listening hour
  if (perHour >= 4) return "#ef4444";
  if (perHour >= 1.5) return "#db7706";
  return "#1a9e4b";
}

// Two uses of the same outline: "network" shows the sites and this phone's spot checks;
// "picker" is the small map in Step 1 where a tap sets the place of the next check.
async function renderMap(mode = "network") {
  const picker = mode === "picker";
  const target = $(picker ? "placeMap" : "uaeMap"), errBox = $(picker ? "phoneError" : "mapError");
  errBox.classList.add("hidden");
  let geo, det;
  try { [geo, det] = await Promise.all([loadUae(), loadDetection()]); }
  catch (e) { showError(errBox, `The map could not be loaded (${e.message || e}).`); return; }
  const [lon0, lat0, lon1, lat1] = geo.bounds, pad = 8;
  const X = (lon) => pad + (lon - lon0) * COS_LAT * MAP_SCALE, Y = (lat) => pad + (lat1 - lat) * MAP_SCALE;
  const W = X(lon1) + pad, H = Y(lat0) + pad;
  const land = geo.emirates.map((e) => e.rings.map((r) =>
    `<path d="M${r.map(([lon, lat]) => `${X(lon).toFixed(1)},${Y(lat).toFixed(1)}`).join("L")}Z" fill="#f5f5f5" stroke="#000000" stroke-width="0.6"/>`).join("")).join("");

  const zones = syntheticZones(det).filter((z) => z.participants >= MIN_PARTICIPANTS);
  const zoneMarks = zones.map((z) => {
    const last = z.vals.length - 1, alarm = z.flags[last].flag;
    return `<circle cx="${X(z.lon)}" cy="${Y(z.lat)}" r="${4 + Math.sqrt(z.load) / 6}" fill="${alarm ? "#ef4444" : "#000000"}" fill-opacity="0.35"
      stroke="${alarm ? "#ef4444" : "#000000"}" stroke-dasharray="3 2"/><text x="${X(z.lon) + 9}" y="${Y(z.lat) + 3}" font-size="9" fill="#000000">${esc(z.city)}</text>`;
  }).join("");

  // own shared counts, added up per map cell
  const cells = new Map();
  for (const b of loadShared()) {
    if (!Array.isArray(b.cell)) continue;
    const key = b.cell.join(","), c = cells.get(key) || { lat: Number(b.cell[0]), lon: Number(b.cell[1]), coughs: 0, seconds: 0 };
    c.coughs += Number(b.coughs) || 0; c.seconds += Number(b.listening_seconds) || 0;
    cells.set(key, c);
  }
  const visits = [...cells.values()].filter((c) => c.seconds > 0);
  const visitMarks = visits.map((c) => {
    const perHour = c.coughs / (c.seconds / 3600);
    return `<circle cx="${X(c.lon)}" cy="${Y(c.lat)}" r="${5 + Math.min(Math.sqrt(c.seconds / 60), 10)}" fill="${rateColor(perHour)}" stroke="#fff" stroke-width="1.5"/>`;
  }).join("");
  const place = loadPlace();
  const pin = place ? `<circle cx="${X(place.lon)}" cy="${Y(place.lat)}" r="4" fill="#fff" stroke="#000000" stroke-width="2"/>` : "";

  target.innerHTML = `<svg viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" style="height:auto" role="img"
    aria-label="${picker ? "Tap to set the place of this check" : "Map of sites and spot checks in the UAE"}">${land}${picker ? "" : zoneMarks + visitMarks}${pin}</svg>`;
  showPlace(place);
  if (picker) {
    target.querySelector("svg").addEventListener("click", (ev) => {
      const box = ev.currentTarget.getBoundingClientRect();
      const x = ((ev.clientX - box.left) / box.width) * W, y = ((ev.clientY - box.top) / box.height) * H;
      savePlace(lat1 - (y - pad) / MAP_SCALE, lon0 + (x - pad) / (COS_LAT * MAP_SCALE));
      buzz(10);
      renderMap("picker");
    });
    return;
  }
  $("visits").innerHTML = visits.length ? `<p class="mono kicker">YOUR SPOT CHECKS</p><table><tr><th>Cell</th><th>Listening</th><th>Coughs</th><th>Per hour</th></tr>${visits.map((c) =>
    `<tr><td>${c.lat.toFixed(2)}, ${c.lon.toFixed(2)}</td><td>${c.seconds < 90 ? `${c.seconds} s` : `${Math.round(c.seconds / 60)} min`}</td><td>${c.coughs}</td>
     <td>${(c.coughs / (c.seconds / 3600)).toFixed(1)}</td></tr>`).join("")}</table>`
    : `<p class="small">No spot checks from this phone yet. Set a place on the "Check in" tab, start a check-in, then press "Finish now and share counts" or wait 15 minutes.</p>`;
}

function useMyLocation() {
  const errBox = $("phoneError");  // the button lives on the Count screen
  errBox.classList.add("hidden");
  if (!navigator.geolocation) { showError(errBox, "This browser cannot give a location. Use \"Tap it on the map\" instead."); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => { savePlace(pos.coords.latitude, pos.coords.longitude); if (document.querySelector("details.picker")?.open) renderMap("picker"); },
    () => showError(errBox, "Location was not shared. Use \"Tap it on the map\" to set the place instead."),
    { enableHighAccuracy: false, maximumAge: 600000, timeout: 15000 });
}
$("useLocation").addEventListener("click", useMyLocation);
$("clearVisits").addEventListener("click", () => {
  if (!window.confirm("Delete your spot checks and saved place from this phone? This cannot be undone.")) return;
  try { localStorage.removeItem(STORE_KEY); localStorage.removeItem(PLACE_KEY); } catch { /* nothing stored */ }
  renderMap("network");
});
showPlace(loadPlace());
document.querySelector("details.picker").addEventListener("toggle", (ev) => { if (ev.currentTarget.open) renderMap("picker"); });

// Cards and blocks fade in as they scroll into view. The class is added here, so without
// JavaScript or with reduced motion everything is simply visible.
function revealOnScroll(selector) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
  const els = [...document.querySelectorAll(selector)];
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }), { rootMargin: "0px 0px -8% 0px" });
  els.forEach((el) => { el.classList.add("reveal"); io.observe(el); });
  // never leave content hidden if the observer does not fire (background tab, old browser)
  window.addEventListener("load", () => setTimeout(() => els.forEach((el) => el.classList.add("in")), 2500));
}
revealOnScroll(".view > .section-title, #view-home .card, #view-about .card");

// The check is the first screen, so its detector starts loading at once, not on scroll.
// (Called here, at the end, because the detector state is declared further down the module.)
ensureLoaded("phone");
ensureLoaded("world");

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => { /* offline cache is optional */ });
}
