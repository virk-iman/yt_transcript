self.addEventListener('install', (event) => {
    console.log('Service Worker installing.');
    // You can pre-cache files here if desired
});

self.addEventListener('activate', (event) => {
    console.log('Service Worker activated.');
});

self.addEventListener('fetch', (event) => {
    // Basic fetch handler to cache-first strategy (optional)
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});