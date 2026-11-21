// Service Worker: permite abrir y usar el panel sin internet.
// Sube CACHE_VERSION cada vez que cambies la lista APP_SHELL o archivos de vendor/.
const CACHE_VERSION = 'v7';
const SHELL_CACHE = `bettermancera-shell-${CACHE_VERSION}`;
const FOTOS_CACHE = 'bettermancera-fotos-v1';
const MAX_FOTOS = 400;
const NETWORK_TIMEOUT_MS = 4000;

const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './offline.js',
  './prefs.js',
  './register-sw.js',
  './styles.css',
  './config.js',
  './manifest.webmanifest',
  './vendor/chart.umd.min.js',
  './vendor/supabase-2.119.0.min.js',
  './vendor/browser-image-compression-2.0.1.js',
  './vendor/fonts/hanken-grotesk-latin-400-normal.woff2',
  './vendor/fonts/hanken-grotesk-latin-600-normal.woff2',
  './vendor/fonts/hanken-grotesk-latin-700-normal.woff2',
  './vendor/fonts/material-symbols-outlined-subset.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

// Archivos con versión en el nombre (no cambian): se sirven directo de caché.
const INMUTABLES = /\/(vendor|icons)\//;
// Fotos públicas de Supabase Storage: nombre único por archivo, no cambian.
const FOTO_PUBLICA = /\/storage\/v1\/object\/public\//;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        // config.js puede no existir en desarrollo: no debe romper la instalación.
        Promise.all(
          APP_SHELL.map((url) =>
            cache.add(new Request(url, { cache: 'reload' })).catch((err) => {
              if (!url.endsWith('config.js')) throw err;
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('bettermancera-') && key !== SHELL_CACHE && key !== FOTOS_CACHE)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

function fetchConTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(
      (res) => {
        clearTimeout(timer);
        resolve(res);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// HTML/JS/CSS propios: red primero (para recibir actualizaciones juntas y
// evitar mezclar versiones), con caché como respaldo si no hay señal.
async function redPrimero(request, esNavegacion) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetchConTimeout(request, NETWORK_TIMEOUT_MS);
    if (response.ok) cache.put(esNavegacion ? './index.html' : request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(esNavegacion ? './index.html' : request, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

async function cachePrimero(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(SHELL_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

async function recortarCacheFotos(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_FOTOS) return;
  await Promise.all(keys.slice(0, keys.length - MAX_FOTOS).map((k) => cache.delete(k)));
}

// Fotos de Supabase: se piden en modo CORS (Storage lo permite) para poder
// guardarlas sin el sobrecosto de las respuestas "opacas".
async function fotoCachePrimero(request) {
  const cache = await caches.open(FOTOS_CACHE);
  const cached = await cache.match(request.url);
  if (cached) return cached;
  try {
    const response = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
    if (response.ok) {
      await cache.put(request.url, response.clone());
      recortarCacheFotos(cache);
    }
    return response;
  } catch (err) {
    return fetch(request);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) {
    if (FOTO_PUBLICA.test(url.pathname)) event.respondWith(fotoCachePrimero(request));
    // API, auth y demás: siempre red (los datos los guarda app.js en IndexedDB).
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(redPrimero(request, true));
    return;
  }

  if (INMUTABLES.test(url.pathname)) {
    event.respondWith(cachePrimero(request));
    return;
  }

  event.respondWith(redPrimero(request, false));
});
