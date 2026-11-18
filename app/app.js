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
const MIN_PARTICIPANTS = 10;    // small-cell suppression
const STORE_KEY = "virufy_shared_counts_v1";

// ---------- shared helpers ----------
const $ = (id) => document.getElementById(id);
// Escape every value that comes from storage or data files before it enters innerHTML.
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function showError(el, msg) { el.textContent = msg; el.classList.remove("hidden"); }
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
    ? `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="#b3261e"/>` : "").join("");
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">
    <path d="${d}" fill="none" stroke="#0f5c4d" stroke-width="2"/>${dots}</svg>`;
}

// ---------- tabs ----------
document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === b));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${b.dataset.view}`));
  if (b.dataset.view === "dashboard") renderDashboard();
  if (b.dataset.view === "about") renderAbout();
}));

// ---------- participant: on-device counting ----------
let classifier = null, audioCtx = null, stream = null, node = null;
let total = 0, lastEventAt = 0, binStart = 0, binCount = 0, buffer = [], bufferLen = 0;
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

const SILENCE_RMS = 0.01;  // seconds quieter than this are not sent to the model (saves the phone's CPU)
let starting = false;

async function startListening() {
  if (starting || node) return;  // ignore repeated taps while loading or listening
  const err = $("phoneError"), btn = $("start");
  err.classList.add("hidden");
  if (!navigator.mediaDevices?.getUserMedia) {
    showError(err, "This browser cannot access the microphone. Open the page over HTTPS in Chrome or Safari.");
    return;
  }
  starting = true; btn.disabled = true;
  const fail = (msg) => { showError(err, msg); starting = false; btn.disabled = false; btn.textContent = "Continue as guest and start"; };
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
  btn.textContent = "Loading the cough detector (about 10 MB the first time)…";
  try {
    classifier = await loadClassifier();
  } catch (e) {
    stream.getTracks().forEach((t) => t.stop()); stream = null; audioCtx.close(); audioCtx = null;
    fail(`The cough detector could not be loaded (${e.message || e}).`);
    return;
  }
  try { await audioCtx.resume(); } catch { /* already running */ }
  const src = audioCtx.createMediaStreamSource(stream);
  node = audioCtx.createScriptProcessor(4096, 1, 1);
  const zone = $("zone").value, rate = audioCtx.sampleRate;
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
  starting = false; btn.disabled = false; btn.textContent = "Continue as guest and start";
  $("consent").classList.add("hidden");
  $("listening").classList.remove("hidden");
  $("thresholdMark").style.left = `${COUGH_THRESHOLD * 100}%`;
  $("status").textContent = `Listening in ${zone}. Audio stays on this phone.`;
}

function onScore(score, zone) {
  const now = Date.now();
  $("meter").style.width = `${Math.round(score * 100)}%`;
  const bin = Math.floor(now / BIN_MS) * BIN_MS;
  if (bin !== binStart) { bins.push({ zone, bin_start: new Date(binStart).toISOString(), coughs: binCount }); binStart = bin; binCount = 0; }
  if (score >= COUGH_THRESHOLD && now - lastEventAt > REFRACTORY_MS) {
    lastEventAt = now; total += 1; binCount += 1;
    $("count").textContent = total; $("binCount").textContent = binCount;
  }
}

function stopListening() {
  try { node?.disconnect(); stream?.getTracks().forEach((t) => t.stop()); audioCtx?.close(); } catch { /* already stopped */ }
  node = null; stream = null; audioCtx = null; buffer = []; bufferLen = 0;
  $("status").textContent = "Stopped. The microphone is off.";
  $("listening").classList.add("hidden"); $("consent").classList.remove("hidden");
}

function shareCounts() {
  const zone = $("zone").value;
  const payload = [...bins, { zone, bin_start: new Date(binStart).toISOString(), coughs: binCount }];
  $("payload").textContent = JSON.stringify(payload, null, 1);
  const ok = saveShared([...loadShared(), ...payload]);
  $("status").textContent = ok
    ? "Counts shared with the demo aggregator on this device (in a pilot they go to the aggregator over HTTPS)."
    : "Could not store the counts on this device (storage is blocked); nothing was shared.";
  bins.length = 0;
}

$("start").addEventListener("click", startListening);
$("stop").addEventListener("click", stopListening);
$("share").addEventListener("click", shareCounts);

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
    ["Airport arrivals hall", 140, 1000, 6], ["Worksite A", 60, 200, 0], ["Labour accommodation B", 45, 200, 0],
    ["District school cluster", 90, 1000, 0], ["Clinic waiting room", 7, 50, 0],
  ];
  return spec.map(([name, participants, load, outbreakDays]) => {
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
    return { name, participants, load, vals, flags, cusum, h, baseline: rate.reduce((x, y) => x + y, 0) / 7,
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
  let zones = [];
  try {
    zones = syntheticZones(await loadDetection());
  } catch (e) {
    showError($("dashError"), `Zone settings could not be loaded (${e.message || e}).`);
  }
  const alerts = [];
  $("zones").innerHTML = zones.map((z) => {
    if (z.participants < MIN_PARTICIPANTS) {
      return `<div class="card zone suppressed"><h4>${z.name}</h4>
        <div class="meta">Hidden: ${z.participants} participants, below the minimum of ${MIN_PARTICIPANTS}.</div></div>`;
    }
    const last = z.vals.length - 1;
    if (z.flags[last].flag) alerts.push({ z });
    return `<div class="card zone"><h4>${z.name}</h4>
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
    return `<div class="card alert"><b>${z.name}</b>: detections ${z.vals[last].toFixed(2)} per listening hour against a baseline of
      ${z.baseline.toFixed(2)}. The sustained-rise statistic (a bank of CUSUMs) is above its alarm level, which is set for about
      one false alarm in 180 days.${delay}<br>
      ${ww}<br>Suggested action: ${action}. Responsible: ${role}. A person decides; the system only recommends.</div>`;
  }).join("") : `<div class="card muted">No zone is above its alarm level today.</div>`;
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

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => { /* offline cache is optional */ });
}
