// Offline cache for the app shell, model and data. No audio is ever cached.
const CACHE = "virufy-v1";
const ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest",
  "./models/yamnet.tflite", "./data/wastewater.json", "./data/esc50_summary.json",
  "./vendor/tasks-audio/audio_bundle.mjs",
];
self.addEventListener("install", (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS))));
self.addEventListener("fetch", (e) => {
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
