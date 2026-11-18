// Offline fallback for the app shell, model and data. No audio is ever cached.
// Network first, so a new deployment is picked up at once; the cache is used only when offline.
const CACHE = "virufy-v9";
const ASSETS = [
  "./", "./index.html", "./app.html", "./landing.js", "./data/europe.json", "./data/monitors.json", "./img/virufy-logo.svg", "./img/virufy-icon.png", "./styles.css", "./app.js", "./manifest.webmanifest",
  "./models/yamnet.tflite", "./data/wastewater.json", "./data/esc50_summary.json", "./data/detection.json", "./data/experiments.json", "./data/uae.json",
  "./vendor/tasks-audio/audio_bundle.mjs",
];
self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
