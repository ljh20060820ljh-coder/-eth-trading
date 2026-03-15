var CACHE_NAME = 'eth-trading-v1';
var urlsToCache = [
  '/',
  '/index.html'
];

// Install: cache core files
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(urlsToCache);
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.filter(function(name) {
          return name !== CACHE_NAME;
        }).map(function(name) {
          return caches.delete(name);
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch: network first, fallback to cache
self.addEventListener('fetch', function(event) {
  // Always fetch API calls from network
  if (event.request.url.includes('api.binance.com') ||
      event.request.url.includes('api.alternative.me') ||
      event.request.url.includes('api.coingecko.com') ||
      event.request.url.includes('api.deepseek.com') ||
      event.request.url.includes('api.emailjs.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // For app files: network first, then cache
  event.respondWith(
    fetch(event.request).then(function(response) {
      // Update cache with latest version
      var responseClone = response.clone();
      caches.open(CACHE_NAME).then(function(cache) {
        cache.put(event.request, responseClone);
      });
      return response;
    }).catch(function() {
      return caches.match(event.request);
    })
  );
});

