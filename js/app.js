// Small helpers the C# side calls. Everything else lives in C#.
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); window.__wbInstall = e; });
window.wb = (function () {
    let keyHandler = null;
    return {
        // Waits until the browser has drawn the page once (or 50 ms, so a hidden tab never stalls the work).
        nextFrame: () => new Promise(resolve => {
            // a hidden tab draws nothing and slows timers to once a second, which made a world take minutes when the person looked
            // away while it was being made: then just let the browser breathe for a moment (a message is not slowed down)
            if (document.hidden) { const ch = new MessageChannel(); ch.port1.onmessage = () => resolve(); ch.port2.postMessage(0); return; }
            let done = false;
            const go = () => { if (!done) { done = true; setTimeout(resolve, 0); } };
            requestAnimationFrame(go);
            setTimeout(go, 50);
        }),

        // Remembered settings. Private windows or blocked storage just mean nothing is remembered.
        getItem: key => { try { return localStorage.getItem(key); } catch { return null; } },
        setItem: (key, value) => { try { localStorage.setItem(key, value); } catch { } },
        removeItem: key => { try { localStorage.removeItem(key); } catch { } },
        trySetItem: (key, value) => { try { localStorage.setItem(key, value); return true; } catch { return false; } },
        // opens an element (a character sheet) on a page of its own, in the light look, and asks the browser to print it
        printElement: (el, title) => {
            if (!el) return;
            const w = window.open("", "_blank");
            if (!w) return;
            const css = new URL("css/app.css", document.baseURI).href;
            const esc = t => String(t).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
            w.document.open();
            w.document.write(`<!doctype html><html data-theme="light"><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="stylesheet" href="${css}"></head>` +
                `<body class="print-page">${el.outerHTML}</body></html>`);
            w.document.close();
            const go = () => { try { w.focus(); w.print(); } catch { } };
            const link = w.document.querySelector("link");
            if (link && !link.sheet) link.addEventListener("load", () => setTimeout(go, 60)); else setTimeout(go, 200);
        },
        copyText: async text => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } },

        setTheme: theme => { document.documentElement.dataset.theme = theme; },

        // Stage 8: a new version has been published. Offer to switch to it (the worlds are kept either way). `worker` is the new offline
        // copy waiting to take over, when there is one; `info` is the new version.json, when known.
        offerUpdate: (worker, info) => {
            if (document.querySelector(".update-banner")) return;
            const bar = document.createElement("div");
            bar.className = "update-banner panel";
            bar.setAttribute("role", "status");
            const text = document.createElement("span");
            text.textContent = info && info.version ? `World Builder ${info.version} is ready.` : "A new version of World Builder is ready.";
            const go = document.createElement("button"); go.className = "primary small"; go.textContent = "Reload";
            const later = document.createElement("button"); later.className = "ghost small"; later.textContent = "Later";
            go.addEventListener("click", async () => {
                go.disabled = true;
                // let a waiting offline copy take over first, then load the page again (it fetches the new version when online)
                try {
                    const reg = await navigator.serviceWorker?.getRegistration();
                    const w = worker || reg?.waiting;
                    if (w) {
                        await new Promise(res => {
                            navigator.serviceWorker.addEventListener("controllerchange", res, { once: true });
                            w.postMessage("skip-waiting");
                            setTimeout(res, 2500);
                        });
                    }
                } catch { }
                location.reload();
            });
            later.addEventListener("click", () => bar.remove());
            bar.append(text, go, later);
            document.body.appendChild(bar);
        },

        // The version this page is running (stamped into the page when it is published) and what the site has now.
        build: () => document.querySelector('meta[name="wb-build"]')?.content || "dev",
        version: async () => {
            try { const r = await fetch("version.json", { cache: "no-cache" }); if (r.ok) return await r.json(); } catch { }
            return null;
        },
        changelog: async () => {
            try { const r = await fetch("changelog.json", { cache: "no-cache" }); if (r.ok) return await r.json(); } catch { }
            return [];
        },

        // Looks for a newer published version every 10 minutes and whenever the page is shown again, so someone exploring the map
        // for a long time is told too (the browser itself only looks when the page is loaded).
        watchUpdates: reg => {
            const mine = wb.build();
            if (mine === "dev") return;
            let last = 0;
            const check = async () => {
                if (document.hidden || Date.now() - last < 60000) return;
                last = Date.now();
                try { reg && reg.update(); } catch { }
                const v = await wb.version();
                if (v && v.build && v.build !== "dev" && v.build !== mine) wb.offerUpdate(reg && reg.waiting, v);
            };
            setInterval(check, 10 * 60 * 1000);
            document.addEventListener("visibilitychange", check);
            window.addEventListener("focus", check);
            window.addEventListener("online", check);
        },

        // Stage 8: "Install World Builder" (browsers that offer it: Chrome and Edge). The browser's own offer is kept until asked for.
        scrollToId: id => { const e = document.getElementById(id); if (e) e.scrollIntoView({ behavior: "smooth", block: "start" }); },
        canInstall: () => !!window.__wbInstall,
        installed: () => window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true,
        install: async () => {
            const p = window.__wbInstall;
            if (!p) return "unavailable";
            window.__wbInstall = null;
            p.prompt();
            try { const r = await p.userChoice; return r.outcome; } catch { return "dismissed"; }
        },
        // reading settings (Stage 7): the text size of the whole page, and less movement (the map jumps instead of gliding)
        setReading: (pct, reduceMotion) => {
            document.documentElement.style.fontSize = pct && pct !== 100 ? pct + "%" : "";
            if (reduceMotion) document.documentElement.dataset.motion = "reduce"; else delete document.documentElement.dataset.motion;
        },
        isNarrow: () => window.matchMedia("(max-width: 760px)").matches,
        width: () => window.innerWidth,
        height: () => window.innerHeight,

        // lets a floating card be dragged by its handle (it keeps where it was put for the next one)
        draggable: (box, handle) => {
            if (!box || !handle || handle.__drag) return;
            handle.__drag = true;
            let from = null;
            const saved = window.__wbDragShift || { x: 0, y: 0 };
            box.style.translate = `${saved.x}px ${saved.y}px`;
            handle.addEventListener("pointerdown", e => {
                if (e.button !== 0 || e.target.closest("button, input, textarea, select, a")) return;
                const s = window.__wbDragShift || { x: 0, y: 0 };
                from = { x: e.clientX - s.x, y: e.clientY - s.y };
                handle.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            handle.addEventListener("pointermove", e => {
                if (!from) return;
                const maxX = Math.max(0, (window.innerWidth - box.offsetWidth) / 2), maxY = Math.max(0, (window.innerHeight - box.offsetHeight) / 2);
                const x = Math.max(-maxX, Math.min(maxX, e.clientX - from.x)), y = Math.max(-maxY, Math.min(maxY, e.clientY - from.y));
                window.__wbDragShift = { x, y };
                box.style.translate = `${x}px ${y}px`;
            });
            const end = () => { from = null; };
            handle.addEventListener("pointerup", end);
            handle.addEventListener("pointercancel", end);
        },

        // Keyboard shortcuts: single keys, ignored while typing in a box (except Escape) and when Ctrl, Alt or Cmd is held,
        // so the browser's own shortcuts keep working.
        listenKeys: (dotnet, keys) => {
            if (keyHandler) window.removeEventListener("keydown", keyHandler);
            keyHandler = e => {
                // the larger view of a settlement sketch is open over everything: Escape closes it, and no other key is a shortcut
                const big = document.querySelector(".sketch-big");
                if (big) { if (e.key === "Escape") { e.preventDefault(); big.querySelector("[data-close]")?.click(); } return; }
                // Ctrl+K (Cmd+K on a Mac) opens search and commands, even while typing
                if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K")) {
                    e.preventDefault();
                    dotnet.invokeMethodAsync("OnKey", "palette");
                    return;
                }
                // Ctrl+S (Cmd+S) saves the world instead of the browser saving the page
                if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "s" || e.key === "S")) {
                    e.preventDefault();
                    dotnet.invokeMethodAsync("OnKey", "save");
                    return;
                }
                if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
                const t = e.target;
                const typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
                if (typing && e.key !== "Escape") return;
                if (!keys.includes(e.key)) return;
                e.preventDefault();
                dotnet.invokeMethodAsync("OnKey", e.key);
            };
            window.addEventListener("keydown", keyHandler);
        },
        stopKeys: () => { if (keyHandler) window.removeEventListener("keydown", keyHandler); keyHandler = null; },

        focus: element => { try { element && element.focus(); } catch { } },

        // Puts a picture (RGBA bytes, w x h) on a canvas.
        drawPicture: (canvas, w, h, rgba) => {
            if (!canvas) return;
            canvas.width = w; canvas.height = h;
            const data = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
            canvas.getContext("2d").putImageData(new ImageData(data, w, h), 0, 0);
        },
    };
})();
