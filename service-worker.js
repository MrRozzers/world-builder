// Stage 8: keeps World Builder working offline once it has been opened. Every file the page asks for is kept as it arrives:
// - files whose names carry a fingerprint (the engine's .wasm and .js parts, ".abc123xyz0.wasm") never change, so they come from
//   the copy kept here first, and only from the internet when there is no copy yet;
// - everything else (the page, its styles and scripts, the list of engine parts) comes from the internet when it can, so a new
//   version shows up at once, and from the copy kept here when offline.
// The publishing script stamps each version into BUILD below; a new version starts a new store and clears the old one, and the
// page offers to reload. Worlds themselves are not kept here: they are in the browser's own storage (IndexedDB), untouched.
const BUILD = "0.9.5-20261013-1938";
const STORE = "worldbuilder-" + BUILD;
const FINGERPRINTED = /\.[a-z0-9]{10}\.(wasm|js|dat|json|pdb)(\.gz|\.br)?$/i;

self.addEventListener("install", event => {
    // the page and its own small files, so it opens offline even if the first visit was cut short
    event.waitUntil(caches.open(STORE).then(c => c.addAll(["./", "index.html", "css/app.css", "manifest.webmanifest"]).catch(() => { })));
});

self.addEventListener("activate", event => {
    event.waitUntil((async () => {
        for (const key of await caches.keys()) if (key.startsWith("worldbuilder-") && key !== STORE) await caches.delete(key);
        await self.clients.claim();
    })());
});

// the page asks the waiting new version to take over (after the person presses Reload), or hands over the list of every file it
// loaded (on the first visit those arrive before this worker is in charge, so they are fetched again here, mostly from the
// browser's own cache, and kept)
self.addEventListener("message", event => {
    if (event.data === "skip-waiting") { self.skipWaiting(); return; }
    if (event.data && Array.isArray(event.data.keep)) event.waitUntil(keepAll(event.data.keep));
});

async function keepAll(urls) {
    const store = await caches.open(STORE);
    for (const u of urls) {
        try {
            const url = new URL(u, self.location.href);
            if (url.origin !== self.location.origin || url.pathname.endsWith("/service-worker.js")) continue;
            const req = new Request(url.href);
            if (await store.match(req, { ignoreSearch: true })) continue;
            const res = await fetch(req);
            if (res.ok) await store.put(req, res);
        } catch { }
    }
}

self.addEventListener("fetch", event => {
    const req = event.request;
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;   // fonts or anything from elsewhere: the browser's usual way
    if (FINGERPRINTED.test(url.pathname)) event.respondWith(cacheFirst(req));
    else event.respondWith(networkFirst(req));
});

async function cacheFirst(req) {
    const store = await caches.open(STORE);
    const hit = await store.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok) store.put(req, res.clone()).catch(() => { });
    return res;
}

async function networkFirst(req) {
    const store = await caches.open(STORE);
    try {
        const res = await fetch(req, { cache: "no-cache" });
        if (res.ok) store.put(req, res.clone()).catch(() => { });
        return res;
    } catch (e) {
        const hit = await store.match(req, { ignoreSearch: true })
            || (req.mode === "navigate" ? await store.match("index.html") || await store.match("./") : undefined);
        if (hit) return hit;
        throw e;
    }
}
