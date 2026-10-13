// Worlds kept in the browser (Stage 4), in IndexedDB, which holds far more than localStorage. Two stores:
//   "index": one small record per world for the My worlds list { id, name, savedAt, width, height, seed, bytes }
//   "data":  the world itself { id, world: Uint8Array (the save file's text, as the desktop writes it), extras: string (JSON) }
// "extras" holds what changes while you use a world (its name, notes and character sheets), so a note or a hit point is saved in a moment
// without writing the whole world again. The world being worked on that is not in My worlds yet lives under the id "_draft".
window.wbStore = (() => {
    "use strict";

    const DB = "worldbuilder", VERSION = 1;
    let opening = null;

    function db() {
        if (opening) return opening;
        opening = new Promise((resolve, reject) => {
            if (!window.indexedDB) { reject(new Error("This browser cannot store worlds (no IndexedDB).")); return; }
            const req = indexedDB.open(DB, VERSION);
            req.onupgradeneeded = () => {
                const d = req.result;
                if (!d.objectStoreNames.contains("index")) d.createObjectStore("index", { keyPath: "id" });
                if (!d.objectStoreNames.contains("data")) d.createObjectStore("data", { keyPath: "id" });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error("Could not open the browser's storage."));
            req.onblocked = () => reject(new Error("The browser's storage is busy in another tab. Close other World Builder tabs and try again."));
        });
        opening.catch(() => { opening = null; });
        return opening;
    }

    // runs fn(stores) in one transaction and resolves when it is safely written
    async function tx(names, mode, fn) {
        const d = await db();
        return new Promise((resolve, reject) => {
            const t = d.transaction(names, mode);
            const stores = names.map(n => t.objectStore(n));
            let result;
            t.fail = msg => { t.__msg = msg; try { t.abort(); } catch { } };
            try { result = fn(...stores, t); } catch (e) { reject(e); return; }
            t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
            t.onerror = () => reject(t.error || new Error("Storage failed."));
            t.onabort = () => reject(new Error(t.__msg || (t.error && t.error.name === "QuotaExceededError" ? quotaHint() : (t.error && t.error.message) || quotaHint())));
        });
    }
    const wrap = req => ({ __req: req });
    const quotaHint = () => "The browser's storage is full. Delete a world you no longer need, or download it as a file first.";

    async function list() {
        const rows = await tx(["index"], "readonly", s => wrap(s.getAll()));
        return (rows || []).filter(r => r.id !== "_draft").sort((a, b) => b.savedAt - a.savedAt);
    }

    // world: Uint8Array or null (null keeps the world already stored under that id and only changes the record and extras)
    async function put(meta, world, extras) {
        const now = Date.now();
        await tx(["index", "data"], "readwrite", (index, data, t) => {
            const getReq = data.get(meta.id);
            getReq.onsuccess = () => {
                const old = getReq.result;
                const w = world || (old && old.world);
                if (!w) { t.fail("Nothing to save."); return; }
                data.put({ id: meta.id, world: w, extras: extras ?? (old ? old.extras : null) });
                index.put({ ...meta, savedAt: now, bytes: w.byteLength });
            };
        });
        return now;
    }

    // only what changed while using the world (cheap: no world written)
    async function putExtras(id, extras) {
        await tx(["index", "data"], "readwrite", (index, data) => {
            const getReq = data.get(id);
            getReq.onsuccess = () => {
                const old = getReq.result;
                if (!old) return;
                old.extras = extras;
                data.put(old);
                const ir = index.get(id);
                ir.onsuccess = () => { if (ir.result) { ir.result.savedAt = Date.now(); index.put(ir.result); } };
            };
        });
    }

    async function get(id) {
        const row = await tx(["data"], "readonly", s => wrap(s.get(id)));
        return row ? { world: row.world, extras: row.extras || null } : null;
    }

    // the same in two parts, each passed back on its own (a byte array alone goes to C# quickly; text alone too)
    async function getWorld(id) { const r = await get(id); return r ? r.world : null; }
    async function getExtras(id) { const r = await get(id); return r ? r.extras : null; }

    async function meta(id) { return (await tx(["index"], "readonly", s => wrap(s.get(id)))) || null; }

    // copies a world to a new id with a new record (the draft becoming a saved world), and drops the old one if asked
    async function copy(fromId, meta, removeOld) {
        const now = Date.now();
        await tx(["index", "data"], "readwrite", (index, data, t) => {
            const r = data.get(fromId);
            r.onsuccess = () => {
                const old = r.result;
                if (!old) { t.fail("The world to copy is not stored."); return; }
                data.put({ id: meta.id, world: old.world, extras: old.extras });
                index.put({ ...meta, savedAt: now, bytes: old.world.byteLength });
                if (removeOld) { data.delete(fromId); index.delete(fromId); }
            };
        });
        return now;
    }

    async function rename(id, name) {
        await tx(["index"], "readwrite", index => {
            const r = index.get(id);
            r.onsuccess = () => { if (r.result) { r.result.name = name; index.put(r.result); } };
        });
    }

    async function remove(id) {
        await tx(["index", "data"], "readwrite", (index, data) => { index.delete(id); data.delete(id); });
    }

    // how much is used and how much the browser allows, and whether it promised not to clear it on its own
    async function estimate() {
        let usage = 0, quota = 0, persisted = false;
        try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); usage = e.usage || 0; quota = e.quota || 0; } } catch { }
        try { if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted(); } catch { }
        return { used: usage, quota, persisted };
    }

    // asks the browser to keep this site's storage unless the person clears it themselves (most browsers decide quietly)
    async function persist() {
        try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; }
    }

    // hands a file to the person (their browser's usual download)
    function download(name, bytes, type) {
        const blob = new Blob([bytes], { type: type || "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
    }

    // opens the hidden file picker (the InputFile element)
    function pick(input) { try { input && input.click(); } catch { } }

    return { list, put, putExtras, get, getWorld, getExtras, meta, copy, rename, remove, estimate, persist, download, pick };
})();
