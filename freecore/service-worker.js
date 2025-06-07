self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open("askjason-cache").then((cache) => {
      return cache.addAll([
        "./index.html",
        "./icons/icon-192x192.png",
        "./icons/icon-512x512.png",
        "./manifest.json"
      ]);
    })
  );
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});
