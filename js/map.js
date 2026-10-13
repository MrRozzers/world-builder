// The map (Stage 2): the world drawn by the graphics card (WebGL2) with pan, zoom, wrap-around, a minimap, a scale bar and zoom
// buttons. All moving and drawing happens here in the page, so it stays smooth; C# hands over the world's picture (RGBA) once per
// layer and asks for things like "show the whole world".
//
// Zoomed out, the map is that picture. Zoomed in on the painted layer (from 1.5 screen pixels per tile), every pixel is painted by
// the desktop app's own graphics-card program (PaintedShader.glsl from the engine, adapted for browsers here): sharp coasts, relief,
// trees, fields, rivers, borders and settlements, exactly as on the desktop.
//
// The view: cx, cy = the world tile at the middle of the screen; ts = screen pixels (CSS) per tile. cx drifts freely as you pan
// east or west (the world wraps) and is wrapped only when drawing; cy is kept between the poles.
window.wbMap = (function () {
    const MAX_TS = 64;                 // the closest zoom: 64 screen pixels per tile
    const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduce";

    let host, canvas, gl, prog, tex, vao, loc = {};
    let W = 0, H = 0;                  // world size in tiles (0 = no world)
    let cx = 0, cy = 0, ts = 1;        // the view
    let fitTs = 1;
    let glide = null;                  // a move in progress (whole world, go to, arrow keys)
    let zoomGoal = null;               // smooth zooming: { logTs, ax, ay } - each frame the zoom closes part of the gap
    let lastFrame = 0;
    let accent = "#d9a441";            // the minimap frame colour (read from the page's theme when it changes)
    let fling = null;                  // drift after a quick drag
    let dirty = true, frameQueued = false;
    let smooth = true;
    let ui = {};                       // controls made here: zoom buttons, zoom readout, scale bar, minimap
    let mini = { img: null, w: 0, h: 0 };
    let dotnet = null;
    let viewTimer = 0;
    let showMini = true, showScale = true, imperial = false;   // imperial: the scale bar in miles (the US customary units setting)

    // ---------------------------------------------------------------- set up

    const VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

    // For each screen pixel: which world tile is under it (wrapping east-west), then the picture's colour there.
    const FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uWorld;     // world size in tiles
uniform vec3 uView;      // cx, cy, ts (CSS pixels per tile)
uniform vec2 uScreen;    // canvas size in device pixels
uniform float uDpr;
out vec4 outColor;
void main() {
    vec2 p = vec2(gl_FragCoord.x, uScreen.y - gl_FragCoord.y) / uDpr;     // CSS pixels from the top left
    vec2 half_ = uScreen / uDpr * 0.5;
    vec2 w = vec2(uView.x, uView.y) + (p - half_) / uView.z;               // world tiles
    if (w.y < 0.0 || w.y > uWorld.y) { outColor = vec4(0.0); return; }      // beyond the poles: let the page show through
    vec2 uv = vec2(w.x / uWorld.x, w.y / uWorld.y);                         // x repeats (the texture wraps)
    vec4 c = texture(uTex, uv);
    // a faint edge at the poles
    float edge = min(w.y, uWorld.y - w.y) * uView.z;
    if (edge < 1.0) c.rgb *= 0.75;
    outColor = vec4(c.rgb, 1.0);
}`;

    function compile(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
    }

    function create(hostElement, dotnetRef) {
        if (host === hostElement && gl) return true;
        host = hostElement;
        dotnet = dotnetRef;
        canvas = document.createElement("canvas");
        canvas.className = "map-canvas";
        canvas.setAttribute("aria-label", "Map. Drag to move, scroll or pinch to zoom.");
        canvas.tabIndex = -1;
        host.appendChild(canvas);
        // the lines (roads, sea routes, province borders) are drawn on a second, see-through canvas over the map
        lineCanvas = document.createElement("canvas");
        lineCanvas.className = "map-lines";
        host.appendChild(lineCanvas);
        lctx = lineCanvas.getContext("2d");
        gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false });
        if (!gl) {
            const note = document.createElement("div");
            note.className = "map-nogl";
            note.textContent = "This browser could not start the graphics card (WebGL2), so the map cannot be drawn. Try an up-to-date Chrome, Edge, Firefox or Safari.";
            host.appendChild(note);
            return false;
        }
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        for (const n of ["uTex", "uWorld", "uView", "uScreen", "uDpr"]) loc[n] = gl.getUniformLocation(prog, n);
        vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);   // one triangle covering the screen
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); }, false);
        canvas.addEventListener("webglcontextrestored", () => { /* the page reloads the picture on the next world or layer */ }, false);

        makeControls();
        if (window.wbGlobe) { try { window.wbGlobe.attach(host, dotnet); } catch (e) { console.warn("The globe could not start", e); } }
        if (window.wbNames) window.wbNames.attach(host, { redraw: changed, view: namesView });
        if (window.wbOverlay) window.wbOverlay.attach(host, { redraw: changed, view: namesView });
        readTheme();
        listen();
        new ResizeObserver(() => { resize(); }).observe(host);
        resize();
        return true;
    }

    // ---------------------------------------------------------------- controls (made here, styled in app.css)

    function el(tag, cls, parent, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined) e.textContent = text;
        if (parent) parent.appendChild(e);
        return e;
    }

    const ICON = {
        plus: '<path d="M12 5v14M5 12h14"/>',
        minus: '<path d="M5 12h14"/>',
        fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    };
    function iconButton(parent, name, title, onClick) {
        const b = el("button", "map-btn", parent);
        b.type = "button";
        b.title = title;
        b.setAttribute("aria-label", title);
        b.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON[name] + "</svg>";
        b.addEventListener("click", onClick);
        return b;
    }

    function makeControls() {
        ui.tip = el("div", "map-tip", host); ui.tip.hidden = true;
        ui.hoverRing = el("div", "map-ring hover", host); ui.hoverRing.hidden = true;
        ui.selRing = el("div", "map-ring selected", host); ui.selRing.hidden = true;
        ui.readout = null;
        const box = el("div", "map-ui", host);
        ui.box = box;
        ui.hoverLine = el("div", "map-readout", host); ui.hoverLine.hidden = true;

        ui.mini = el("canvas", "minimap", box);
        ui.mini.title = "The whole world. Click or drag to move there.";
        ui.mini.setAttribute("aria-label", "Minimap");

        const row = el("div", "map-row", box);
        ui.scale = el("div", "scalebar", row);
        ui.scaleLine = el("span", "scale-line", ui.scale);
        ui.scaleText = el("span", "scale-text", ui.scale);

        const zoom = el("div", "map-zoom", row);
        iconButton(zoom, "minus", "Zoom out (-)", () => zoomBy(1 / 1.6));
        ui.readout = el("button", "zoom-readout", zoom, "100%");
        ui.readout.type = "button";
        ui.readout.title = "Zoom. Click to see the whole world (Home).";
        ui.readout.addEventListener("click", () => fit(true));
        iconButton(zoom, "plus", "Zoom in (+)", () => zoomBy(1.6));
        iconButton(zoom, "fit", "Whole world (Home)", () => fit(true));

        // the minimap: click or drag to centre the map there
        let dragging = false;
        const go = e => {
            if (!W) return;
            const r = ui.mini.getBoundingClientRect();
            const x = (e.clientX - r.left) / r.width * W, y = (e.clientY - r.top) / r.height * H;
            stopMotion();
            // stay on the same lap of the wrap, so the map does not spin round
            const dx = x - wrapX(cx);
            cx += dx - W * Math.round(dx / W);
            cy = y;
            clampView();
            changed();
        };
        ui.mini.addEventListener("pointerdown", e => { dragging = true; ui.mini.setPointerCapture(e.pointerId); go(e); });
        ui.mini.addEventListener("pointermove", e => { if (dragging) go(e); });
        ui.mini.addEventListener("pointerup", () => { dragging = false; });
        ui.mini.addEventListener("pointercancel", () => { dragging = false; });
        updateUi();
    }

    // ---------------------------------------------------------------- the picture

    function setWorld(w, h) {
        W = w; H = h;
        if (paint) paint.ready = false;   // the close-up data belongs to the old world until the new one arrives
        lines = null;
        selection = null;
        if (window.wbNames) window.wbNames.clear();
        stopMotion();
        cx = W / 2; cy = H / 2;
        computeFit();
        ts = fitTs;
        changed();
    }

    // The world's picture: RGBA bytes, iw x ih (may be smaller than the world; it is stretched over it).
    function setImage(iw, ih, rgba, smoothPicture, paintedLayer) {
        if (window.wbGlobe) window.wbGlobe.setImage(iw, ih, rgba, W, H);
        if (!gl) return;
        smooth = !!smoothPicture;
        detailed = !!paintedLayer;
        gl.activeTexture(gl.TEXTURE0);
        if (!tex) tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        const data = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, iw, ih, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);           // east-west wrap
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, smooth ? gl.LINEAR : gl.NEAREST);

        // a small copy for the minimap
        const off = document.createElement("canvas");
        off.width = iw; off.height = ih;
        off.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), iw, ih), 0, 0);
        const mw = 220, mh = Math.max(1, Math.round(mw * ih / iw));
        const small = document.createElement("canvas");
        small.width = mw; small.height = mh;
        const g = small.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(off, 0, 0, mw, mh);
        mini = { img: small, w: mw, h: mh };
        changed();
    }

    function clear() {
        W = 0; H = 0;
        mini = { img: null, w: 0, h: 0 };
        changed();
    }

    // ---------------------------------------------------------------- view maths

    function viewSize() { return { w: host ? host.clientWidth : 1, h: host ? host.clientHeight : 1 }; }
    function wrapX(x) { return ((x % W) + W) % W; }
    function minTs() { return fitTs * 0.5; }

    function computeFit() {
        const v = viewSize();
        // the whole world's height, leaving room for the panels at the top and bottom
        const room = Math.max(120, v.h - 150);
        fitTs = Math.min(room / Math.max(1, H), MAX_TS);   // the height decides (sideways, the map wraps)
    }

    function clampView() {
        if (!W) return;
        ts = Math.min(MAX_TS, Math.max(minTs(), ts));
        const v = viewSize();
        const visibleTiles = v.h / ts;
        if (visibleTiles >= H) cy = H / 2;   // the whole height fits: keep it centred
        else {
            const margin = 70 / ts;           // a little room so the poles can be seen past the panels
            const lo = visibleTiles / 2 - margin, hi = H - visibleTiles / 2 + margin;
            cy = Math.min(hi, Math.max(lo, cy));
        }
        // keep cx from drifting into numbers so large that precision suffers
        if (Math.abs(cx) > W * 1000) cx = wrapX(cx);
    }

    function zoomPercent() { return ts / Math.max(1e-9, fitTs) * 100; }   // 100% = the whole world fits

    // ---------------------------------------------------------------- moving the view

    function stopMotion() { glide = null; fling = null; zoomGoal = null; }

    // Zoom by a factor, keeping the world point under (ax, ay) (CSS pixels from the canvas centre) still.
    // Smooth zooming works like a spring: each wheel notch moves a goal, and every frame the zoom closes part of the gap. Notches that
    // come quickly simply add up, so it never stops and restarts between them.
    function zoomAt(factor, ax, ay, animate) {
        if (!W) return;
        fling = null;
        glide = null;
        const lo = Math.log(minTs()), hi = Math.log(MAX_TS);
        if (!animate || reduceMotion()) {
            const to = Math.exp(Math.min(hi, Math.max(lo, Math.log(ts * factor))));
            const wx = cx + ax / ts, wy = cy + ay / ts;
            ts = to; cx = wx - ax / ts; cy = wy - ay / ts;
            zoomGoal = null;
            clampView(); changed();
            return;
        }
        const base = zoomGoal ? zoomGoal.logTs : Math.log(ts);
        zoomGoal = { logTs: Math.min(hi, Math.max(lo, base + Math.log(factor))), ax, ay };
        kick();
    }

    function zoomBy(factor) { zoomAt(factor, 0, 0, true); }

    function fit(animate) {
        if (!W) return;
        computeFit();
        const toCx = cx, toCy = H / 2;
        if (!animate || reduceMotion()) { stopMotion(); ts = fitTs; cy = toCy; clampView(); changed(); return; }
        glide = { kind: "move", fromCx: cx, fromCy: cy, fromTs: ts, toCx, toCy, toTs: fitTs, start: performance.now(), dur: 320 };
        fling = null; zoomGoal = null;
        kick();
    }

    // centre on a tile, zooming in to at least minZoomPercent (used by search and cards later)
    // (minTs: also at least this many screen pixels per tile, the desktop's way of saying how close to go)
    function goTo(x, y, minZoomPercent, minTs) {
        if (!W) return;
        if (window.wbGlobe && window.wbGlobe.active()) window.wbGlobe.goTo(x - 0.5, y - 0.5);
        const want = Math.max(ts, (minZoomPercent || 0) / 100 * fitTs, minTs || 0);
        const dx = x - wrapX(cx);
        const toCx = cx + dx - W * Math.round(dx / W);
        if (reduceMotion()) { stopMotion(); cx = toCx; cy = y; ts = Math.min(MAX_TS, want); clampView(); changed(); return; }
        glide = { kind: "move", fromCx: cx, fromCy: cy, fromTs: ts, toCx, toCy: y, toTs: Math.min(MAX_TS, want), start: performance.now(), dur: 450 };
        fling = null; zoomGoal = null;
        kick();
    }

    // where the map is looking (for a card's Back button to return to), and going back there
    function getView() { return { cx, cy, ts }; }
    function setView(v) {
        if (!W || !v || !(v.ts > 0)) return;
        const dx = v.cx - wrapX(cx);
        const toCx = cx + dx - W * Math.round(dx / W);
        if (reduceMotion()) { stopMotion(); cx = toCx; cy = v.cy; ts = Math.min(MAX_TS, v.ts); clampView(); changed(); return; }
        glide = { kind: "move", fromCx: cx, fromCy: cy, fromTs: ts, toCx, toCy: v.cy, toTs: Math.min(MAX_TS, v.ts), start: performance.now(), dur: 450 };
        fling = null; zoomGoal = null;
        kick();
    }

    function panBy(dx, dy) {   // CSS pixels: the map moves with the pointer
        cx -= dx / ts; cy -= dy / ts;
        clampView(); changed();
    }

    function key(k) {
        if (!W) return false;
        const v = viewSize(), step = Math.min(v.w, v.h) * 0.25;
        switch (k) {
            case "ArrowLeft": glidePan(step, 0); return true;
            case "ArrowRight": glidePan(-step, 0); return true;
            case "ArrowUp": glidePan(0, step); return true;
            case "ArrowDown": glidePan(0, -step); return true;
            case "+": case "=": zoomBy(1.6); return true;
            case "-": case "_": zoomBy(1 / 1.6); return true;
            case "Home": case "0": fit(true); return true;
        }
        return false;
    }

    function glidePan(dx, dy) {
        const toCx = cx - dx / ts, toCy = cy - dy / ts;
        if (reduceMotion()) { panBy(dx, dy); return; }
        glide = { kind: "move", fromCx: cx, fromCy: cy, fromTs: ts, toCx, toCy, toTs: ts, start: performance.now(), dur: 200 };
        fling = null; zoomGoal = null;
        kick();
    }

    const ease = t => 1 - Math.pow(1 - t, 3);

    function step(now) {
        let moving = false;
        const dt = lastFrame ? Math.min(50, Math.max(1, now - lastFrame)) : 16;
        lastFrame = now;
        if (zoomGoal) {
            // close about 85% of the gap every 100 ms, whatever the frame rate
            const k = 1 - Math.exp(-dt / 52);
            const cur = Math.log(ts), next = cur + (zoomGoal.logTs - cur) * k;
            const done = Math.abs(zoomGoal.logTs - next) < 0.002;
            const newTs = Math.exp(done ? zoomGoal.logTs : next);
            const wx = cx + zoomGoal.ax / ts, wy = cy + zoomGoal.ay / ts;   // the point under the pointer stays put
            ts = newTs; cx = wx - zoomGoal.ax / ts; cy = wy - zoomGoal.ay / ts;
            clampView();
            if (done) zoomGoal = null; else moving = true;
            dirty = true;
        }
        if (glide) {
            const t = Math.min(1, (now - glide.start) / glide.dur), e = ease(t);
            ts = Math.exp(Math.log(glide.fromTs) + (Math.log(glide.toTs) - Math.log(glide.fromTs)) * e);   // even zoom speed
            cx = glide.fromCx + (glide.toCx - glide.fromCx) * e;
            cy = glide.fromCy + (glide.toCy - glide.fromCy) * e;
            clampView();
            if (t >= 1) glide = null; else moving = true;
            dirty = true;
        }
        if (fling) {
            const dt = Math.min(50, now - fling.last);
            fling.last = now;
            panBy(fling.vx * dt, fling.vy * dt);
            const decay = Math.pow(0.0025, dt / 1000);   // slows to a stop in about a second
            fling.vx *= decay; fling.vy *= decay;
            if (Math.hypot(fling.vx, fling.vy) < 0.02) fling = null; else moving = true;
        }
        return moving;
    }

    // ---------------------------------------------------------------- pointer, wheel and touch

    function listen() {
        const pointers = new Map();
        let press = null;
        let last = null, samples = [];
        let pinch = null;

        canvas.addEventListener("pointerdown", e => {
            if (!W || (e.pointerType === "mouse" && e.button !== 0)) return;
            canvas.setPointerCapture(e.pointerId);
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            press = pointers.size === 1 ? { x: e.clientX, y: e.clientY, t: performance.now(), moved: false } : null;
            hideHover();
            stopMotion();
            samples = [];
            if (pointers.size === 1) { last = { x: e.clientX, y: e.clientY }; canvas.classList.add("grabbing"); }
            if (pointers.size === 2) pinch = pinchState(pointers);
        });

        canvas.addEventListener("pointermove", e => {
            if (!pointers.has(e.pointerId)) { if (e.pointerType === "mouse") hoverAt(e.clientX, e.clientY); return; }
            if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) press.moved = true;
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size >= 2 && pinch) {
                const now = pinchState(pointers);
                const r = canvas.getBoundingClientRect();
                const ax = now.mx - r.left - r.width / 2, ay = now.my - r.top - r.height / 2;
                // move with the fingers' midpoint, then zoom about it
                panBy(now.mx - pinch.mx, now.my - pinch.my);
                if (pinch.d > 0 && now.d > 0) zoomAt(now.d / pinch.d, ax, ay, false);
                pinch = now;
                return;
            }
            if (last) {
                const dx = e.clientX - last.x, dy = e.clientY - last.y;
                last = { x: e.clientX, y: e.clientY };
                panBy(dx, dy);
                samples.push({ t: performance.now(), dx, dy });
                if (samples.length > 6) samples.shift();
            }
        });

        const up = e => {
            if (!pointers.has(e.pointerId)) return;
            if (e.type === "pointerup" && press && !press.moved && pointers.size === 1 && performance.now() - press.t < 700) clickAt(e.clientX, e.clientY);
            press = null;
            pointers.delete(e.pointerId);
            if (pointers.size < 2) pinch = null;
            if (pointers.size === 1) { const p = [...pointers.values()][0]; last = { x: p.x, y: p.y }; samples = []; return; }
            if (pointers.size === 0) {
                canvas.classList.remove("grabbing");
                last = null;
                // a quick drag keeps drifting for a moment
                const now = performance.now();
                const recent = samples.filter(s => now - s.t < 90);
                if (recent.length >= 2 && !reduceMotion()) {
                    const span = Math.max(16, now - recent[0].t);
                    const vx = recent.reduce((a, s) => a + s.dx, 0) / span, vy = recent.reduce((a, s) => a + s.dy, 0) / span;
                    if (Math.hypot(vx, vy) > 0.25) { fling = { vx, vy, last: now }; kick(); }
                }
                samples = [];
            }
        };
        canvas.addEventListener("pointerup", up);
        canvas.addEventListener("pointercancel", up);
        canvas.addEventListener("pointerleave", () => hideHover());

        // right-click (or a long press on a touch screen): the map's menu (send the party, roll an encounter, open the card here)
        canvas.addEventListener("contextmenu", e => {
            e.preventDefault();
            if (!W || !dotnet) return;
            const [x, y] = localPoint(e.clientX, e.clientY);
            const tile = tileAt(x, y);
            if (!tile) return;
            const hit = window.wbNames ? window.wbNames.hitAt(x, y) : null;
            hideHover();
            dotnet.invokeMethodAsync("OnMapContext", tile[0], tile[1], hit && hit.kind === "city" ? hit.index : -1, e.clientX, e.clientY).catch(() => { });
        });

        canvas.addEventListener("wheel", e => {
            if (!W) return;
            e.preventDefault();
            const r = canvas.getBoundingClientRect();
            const ax = e.clientX - r.left - r.width / 2, ay = e.clientY - r.top - r.height / 2;
            let dy = e.deltaY;
            if (e.deltaMode === 1) dy *= 16; else if (e.deltaMode === 2) dy *= r.height;
            if (e.ctrlKey) {
                // a trackpad pinch (browsers report it as Ctrl+wheel): follow the fingers, lightly smoothed
                zoomAt(Math.exp(-Math.max(-60, Math.min(60, dy)) * 0.012), ax, ay, true);
            } else {
                // a mouse wheel notch or a two-finger scroll: about 1.3x per notch, smoothed
                zoomAt(Math.exp(-Math.max(-250, Math.min(250, dy)) * 0.0026), ax, ay, true);
            }
        }, { passive: false });

        canvas.addEventListener("dblclick", e => {
            if (!W) return;
            const r = canvas.getBoundingClientRect();
            zoomAt(e.shiftKey ? 1 / 2 : 2, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2, true);
        });
    }

    function pinchState(pointers) {
        const [a, b] = [...pointers.values()];
        return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
    }

    // ---------------------------------------------------------------- drawing

    function resize() {
        if (!canvas) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(host.clientWidth * dpr)), h = Math.max(1, Math.round(host.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        if (lineCanvas && (lineCanvas.width !== w || lineCanvas.height !== h)) { lineCanvas.width = w; lineCanvas.height = h; }
        if (W) {
            const wasFit = Math.abs(ts - fitTs) < 1e-6;
            computeFit();
            if (wasFit) ts = fitTs;
            clampView();
        }
        changed();
    }

    function changed() { dirty = true; kick(); }

    function kick() {
        if (frameQueued) return;
        frameQueued = true;
        requestAnimationFrame(frame);
    }

    function frame(now) {
        frameQueued = false;
        const moving = step(now);
        if (dirty) { draw(); updateUi(); dirty = false; tellView(); }
        if (moving) kick(); else lastFrame = 0;
    }

    function draw() {
        drawGl();
        drawLines();
        if (window.wbNames) window.wbNames.frame(namesView());
        if (window.wbOverlay) window.wbOverlay.frame(namesView());
        placeSelection();
    }

    // the view as the names (names.js) need it
    function namesView() {
        const v = viewSize();
        return {
            cx, cy, ts, W, H, fitTs, w: v.w, h: v.h,
            dpr: canvas ? canvas.width / Math.max(1, host.clientWidth) : 1,
            // the close-up painting draws the settlements itself when it is on screen with them ticked
            paintTowns: !!(detailed && paint && paint.ready && !paint.failed && ts >= DETAIL_FROM && overlay.settlements),
        };
    }

    function drawGl() {
        if (!gl) return;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (!W || !tex) return;
        if (detailed && paint && paint.ready && ts >= DETAIL_FROM) { drawPainted(); return; }
        gl.useProgram(prog);
        gl.bindVertexArray(vao);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(loc.uTex, 0);
        gl.uniform2f(loc.uWorld, W, H);
        // cx is wrapped here (the shader works in single precision)
        gl.uniform3f(loc.uView, wrapX(cx), cy, ts);
        gl.uniform2f(loc.uScreen, canvas.width, canvas.height);
        gl.uniform1f(loc.uDpr, canvas.width / Math.max(1, host.clientWidth));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    function updateUi() {
        if (!ui.box) return;
        ui.box.hidden = !W;
        if (!W) return;
        ui.readout.textContent = Math.round(zoomPercent()).toLocaleString("en-US") + "%";

        // the scale bar: a round distance up to 120 pixels wide, measured at the latitude of the middle of the screen
        ui.scale.hidden = !showScale;
        if (showScale) {
            const lat = (0.5 - cy / H) * Math.PI;
            const kmPerPx = Math.PI * 6371 / H * Math.max(0.05, Math.cos(lat)) / ts;
            const f = imperial ? 0.621371 : 1;   // a round number of miles, or of km
            const maxU = kmPerPx * 120 * f;
            const p = Math.pow(10, Math.floor(Math.log10(maxU)));
            const km = (maxU >= 5 * p ? 5 * p : maxU >= 2 * p ? 2 * p : p) / f;
            ui.scaleLine.style.width = Math.max(10, km / kmPerPx).toFixed(1) + "px";
            ui.scaleText.textContent = scaleLabel(km);
        }

        // the minimap and the part of the world on screen
        ui.mini.hidden = !showMini || !mini.img;
        if (showMini && mini.img) {
            const c = ui.mini;
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const cw = 220, ch = Math.round(cw * H / W);
            if (c.width !== cw * dpr) { c.width = cw * dpr; c.height = ch * dpr; c.style.width = cw + "px"; c.style.height = ch + "px"; }
            const g = c.getContext("2d");
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            g.clearRect(0, 0, cw, ch);
            g.drawImage(mini.img, 0, 0, cw, ch);
            const v = viewSize();
            const vw = Math.min(W, v.w / ts), vh = Math.min(H, v.h / ts);
            const sx = cw / W, sy = ch / H;
            const left = wrapX(cx - vw / 2) * sx, top = Math.max(0, cy - vh / 2) * sy, w = vw * sx, h = Math.min(ch, vh * sy);
            g.lineWidth = 1.5;
            g.strokeStyle = accent;
            g.fillStyle = "rgba(255,255,255,0.12)";
            const box = x => { g.fillRect(x, top, w, h); g.strokeRect(x + .75, top + .75, Math.max(2, w - 1.5), Math.max(2, h - 1.5)); };
            if (w >= cw - 1) { g.strokeStyle = accent; g.strokeRect(.75, top + .75, cw - 1.5, Math.max(2, h - 1.5)); }
            else { box(left); if (left + w > cw) box(left - cw); }   // straddling the date line: draw both halves
        }
    }

    function scaleLabel(km) {
        const mi = km * 0.621371;
        const miles = mi >= 10 ? Math.round(mi).toLocaleString("en-US") + " mi" : mi >= 1 ? (+mi.toFixed(1)) + " mi" : (+mi.toFixed(2)) + " mi";
        const kms = km >= 10 ? Math.round(km).toLocaleString("en-US") + " km" : km >= 1 ? (+km.toFixed(1)) + " km" : Math.round(km * 1000) + " m";
        if (imperial) return mi < 1 ? Math.round(km * 3280.84).toLocaleString("en-US") + " ft (" + kms + ")" : miles + " (" + kms + ")";
        return kms + " (" + miles + ")";
    }

    // tell C# where the view is, once it settles (for bookmarks and the status line later)
    function tellView() {
        if (!dotnet || !W) return;
        clearTimeout(viewTimer);
        viewTimer = setTimeout(() => {
            dotnet.invokeMethodAsync("OnMapView", wrapX(cx), cy, zoomPercent()).catch(() => { });
        }, 200);
    }

    function readTheme() {
        if (host) accent = getComputedStyle(host).getPropertyValue("--accent").trim() || accent;
    }

    function redraw() { readTheme(); changed(); }

    function options(o) {
        if (o.minimap !== undefined) showMini = !!o.minimap;
        if (o.scale !== undefined) showScale = !!o.scale;
        if (o.imperial !== undefined) imperial = !!o.imperial;
        changed();
    }

    // ---------------------------------------------------------------- pointing and clicking (2.8)
    //
    // The names layer (names.js) knows what it drew where; anything else under the pointer is a tile. C# says what it is (the hover
    // note and the line of facts about the ground) and opens its card on a click.

    let hoverKey = "", hoverSeq = 0, hoverTimer = 0;
    let selection = null;              // { tx, ty, r } the marker whose card is open, ringed in gold

    function localPoint(clientX, clientY) {
        const r = canvas.getBoundingClientRect();
        return [clientX - r.left, clientY - r.top];
    }

    function tileAt(x, y) {
        const v = viewSize();
        const wy = cy + (y - v.h / 2) / ts;
        if (wy < 0 || wy >= H) return null;
        return [Math.floor(wrapX(cx + (x - v.w / 2) / ts)), Math.floor(wy)];
    }

    // what is under a point: the clock's and party's marks first (overlay.js), then names and markers (names.js)
    function hitUnder(x, y) {
        const o = window.wbOverlay ? window.wbOverlay.hitAt(x, y) : null;
        if (o) return { kind: o.kind, index: o.index, overlay: true, tip: o.tip };
        return window.wbNames ? window.wbNames.hitAt(x, y) : null;
    }

    function hoverAt(clientX, clientY) {
        if (!W || !dotnet) return;
        const [x, y] = localPoint(clientX, clientY);
        const hit = hitUnder(x, y);
        const tile = tileAt(x, y);
        canvas.style.cursor = hit ? "pointer" : "";
        if (hit && hit.r && !hit.overlay) { ring(ui.hoverRing, hit.x, hit.y, hit.r + 2); } else ui.hoverRing.hidden = true;
        if (!tile) { hideHover(); return; }
        const key = (hit ? hit.kind + ":" + hit.index : "") + "|" + tile[0] + "," + tile[1];
        ui.tip.style.left = (x + 14) + "px"; ui.tip.style.top = (y + 16) + "px";
        if (key === hoverKey) return;
        hoverKey = key;
        clearTimeout(hoverTimer);
        const seq = ++hoverSeq;
        hoverTimer = setTimeout(() => {
            dotnet.invokeMethodAsync("OnMapHover", hit ? hit.kind : "tile", hit ? hit.index : -1, tile[0], tile[1]).then(r => {
                if (seq !== hoverSeq || !r) return;
                ui.tip.textContent = r[0] || "";
                ui.tip.hidden = !r[0];
                ui.hoverLine.textContent = r[1] || "";
                ui.hoverLine.hidden = !r[1];
            }).catch(() => { });
        }, 40);
    }

    function hideHover() {
        hoverKey = ""; hoverSeq++;
        clearTimeout(hoverTimer);
        if (ui.tip) ui.tip.hidden = true;
        if (ui.hoverRing) ui.hoverRing.hidden = true;
        if (ui.hoverLine) ui.hoverLine.hidden = true;
    }

    function clickAt(clientX, clientY) {
        if (!W || !dotnet) return;
        const [x, y] = localPoint(clientX, clientY);
        const hit = hitUnder(x, y);
        const tile = tileAt(x, y);
        if (!hit && !tile) return;
        if (hit && hit.overlay && !tile) return;
        selection = hit && hit.r && !hit.overlay ? { tx: hit.tx, ty: hit.ty, r: hit.r + 2 } : null;
        placeSelection();
        dotnet.invokeMethodAsync("OnMapClick", hit ? hit.kind : "tile", hit ? hit.index : -1, tile ? tile[0] : hit.tx, tile ? tile[1] : hit.ty, ts).catch(() => { });
    }

    // the gold ring stays on its place as the map moves
    function placeSelection() {
        if (!ui.selRing) return;
        if (!selection || !W) { ui.selRing.hidden = true; return; }
        const v = viewSize();
        let dx = selection.tx + 0.5 - cx;
        dx -= W * Math.round(dx / W);
        ring(ui.selRing, v.w / 2 + dx * ts, v.h / 2 + (selection.ty + 0.5 - cy) * ts, selection.r);
    }

    function ring(elem, x, y, r) {
        elem.hidden = false;
        elem.style.width = elem.style.height = (2 * r) + "px";
        elem.style.transform = `translate(${x - r}px, ${y - r}px)`;
    }

    // C# can ring a place (a card opened from a link or a search) or clear the ring (the card was closed)
    function select(tx, ty, r) {
        selection = tx === null || tx === undefined ? null : { tx, ty, r: r || 11 };
        placeSelection();
    }

    // ---------------------------------------------------------------- lines: roads, sea routes and province borders (2.5)
    //
    // Drawn as the desktop draws them, over the map. Each line is turned into a path once, in world tiles, and the paths are kept in
    // buckets by area, so a frame only strokes the buckets on screen (scaled and shifted to the view, once per copy of the wrapping
    // world that shows).

    let lineCanvas = null, lctx = null;
    let lines = null;                  // { routes: { [style]: buckets }, provinces: buckets }
    let lineOpts = { routes: true, provinces: false, mountains: true };
    let mountains = null;              // the painted map's drawn mountains (MountainSymbols.Flat; see drawMountains)
    const BUCKET = 96;                 // tiles

    // the route styles, as the desktop: from = the zoom (screen pixels per tile of a 512-row world) a route starts to show
    const ROUTE_STYLES = {
        roadMajor: { from: 1.2, sea: false }, roadMinor: { from: 3.5, sea: false },
        seaMajor: { from: 0.8, sea: true }, seaMinor: { from: 1.6, sea: true }, ferry: { from: 1.6, sea: true, ferry: true },
    };

    function bucketize(list) {   // list of { path, minX, maxX, minY, maxY } -> buckets of merged paths with their bounds
        const map = new Map();
        for (const l of list) {
            const key = Math.floor((l.minX + l.maxX) / 2 / BUCKET) + "," + Math.floor((l.minY + l.maxY) / 2 / BUCKET);
            let b = map.get(key);
            if (!b) { b = { path: new Path2D(), minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }; map.set(key, b); }
            b.path.addPath(l.path);
            b.minX = Math.min(b.minX, l.minX); b.maxX = Math.max(b.maxX, l.maxX);
            b.minY = Math.min(b.minY, l.minY); b.maxY = Math.max(b.maxY, l.maxY);
        }
        return [...map.values()];
    }

    // Roads and routes: their kinds (0 road, 1 sea, 2 ferry), whether each is a main one, where each one's points start, and the
    // points (tile x, y pairs). Province borders: where each starts, and the points (tile corners, x running on past the edge).
    function setLines(routeCount, kinds, major, starts, points, provinceCount, pStarts, pPoints, mountainBytes) {
        mountains = mountainBytes ? view(Float32Array, mountainBytes) : null;
        if (mountains && !mountains.length) mountains = null;
        const st = view(Int32Array, starts), pt = view(Int16Array, points);
        const groups = { roadMajor: [], roadMinor: [], seaMajor: [], seaMinor: [], ferry: [] };
        const single = new Array(routeCount);
        for (let i = 0; i < routeCount; i++) {
            const a = st[i], b = st[i + 1];
            if (b - a < 2) continue;
            const path = new Path2D();
            let prev = 0, ux = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (let k = a; k < b; k++) {
                const tx = pt[2 * k] + 0.5, ty = pt[2 * k + 1] + 0.5;
                if (k === a) ux = tx;
                else { let dx = tx - prev; if (dx > W / 2) dx -= W; else if (dx < -W / 2) dx += W; ux += dx; }   // keep going across the edge
                prev = tx;
                if (k === a) path.moveTo(ux, ty); else path.lineTo(ux, ty);
                minX = Math.min(minX, ux); maxX = Math.max(maxX, ux); minY = Math.min(minY, ty); maxY = Math.max(maxY, ty);
            }
            const style = kinds[i] === 2 ? "ferry" : kinds[i] === 1 ? (major[i] ? "seaMajor" : "seaMinor") : (major[i] ? "roadMajor" : "roadMinor");
            groups[style].push({ path, minX, maxX, minY, maxY });
            single[i] = { path, minX, maxX, minY, maxY, style };
        }
        const routes = {};
        for (const [k, list] of Object.entries(groups)) routes[k] = bucketize(list);

        const ps = view(Int32Array, pStarts), pp = view(Float32Array, pPoints);
        const prov = [];
        for (let i = 0; i < provinceCount; i++) {
            const a = ps[i], b = ps[i + 1];
            if (b - a < 2) continue;
            const path = new Path2D();
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (let k = a; k < b; k++) {
                const x = pp[2 * k], y = pp[2 * k + 1];
                if (k === a) path.moveTo(x, y); else path.lineTo(x, y);
                minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
            prov.push({ path, minX, maxX, minY, maxY });
        }
        lines = { routes, provinces: bucketize(prov), single };
        routeStates = null;
        routeTrade = null;                // its bands point at the old routes; the trade comes again after the lines
        changed();
    }

    // roads and sea lanes the weather slows (1) or closes (2), by route, with their colours (Stage 5)
    let routeStates = null, stateColours = { slowed: "rgb(246,150,30)", closed: "rgb(226,52,44)" };
    function setRouteStates(states, slowed, closed) {
        routeStates = states && states.length ? states : null;
        if (slowed) stateColours = { slowed, closed };
        changed();
    }

    // how much trade each route carries (0 none, else 0.14 to 1), drawn over the routes in teal with the trade layer (polish)
    // The routes are sorted once into width bands by route style and kept in buckets, so a frame strokes a few merged paths rather than
    // every route on its own.
    let routeTrade = null;             // { [style]: [{ width, buckets }] }
    function setRouteTrade(values) {
        routeTrade = null;
        if (values && values.length && lines && lines.single && values.length === lines.single.length) {
            const groups = {};
            for (let i = 0; i < values.length; i++) {
                const tf = values[i], r = lines.single[i];
                if (!(tf > 0) || !r) continue;
                const band = Math.max(1, Math.round(tf * 6));
                const g = (groups[r.style] = groups[r.style] || {});
                (g[band] = g[band] || []).push(r);
            }
            routeTrade = {};
            for (const [style, bands] of Object.entries(groups))
                routeTrade[style] = Object.entries(bands).map(([band, list]) => ({ width: 1.0 + 4.5 * band / 6, buckets: bucketize(list) }));
        }
        changed();
    }

    function setLineOptions(o) {
        if (o.routes !== undefined) lineOpts.routes = !!o.routes;
        if (o.provinces !== undefined) lineOpts.provinces = !!o.provinces;
        if (o.mountains !== undefined) lineOpts.mountains = !!o.mountains;
        changed();
    }

    // strokes the buckets that reach the screen, once for each copy of the world they show in
    let linesDrawn = false;            // whether the last frame drew any line (the canvas is hidden when not, so nothing stale can show)

    function strokeBuckets(buckets, dpr, vw, vh, style) {
        const x0 = cx - vw / 2 / ts, x1 = cx + vw / 2 / ts, y0 = cy - vh / 2 / ts, y1 = cy + vh / 2 / ts;
        const pad = 4 / ts;
        for (const b of buckets) {
            if (b.maxY < y0 - pad || b.minY > y1 + pad) continue;
            const kLo = Math.ceil((x0 - pad - b.maxX) / W), kHi = Math.floor((x1 + pad - b.minX) / W);
            for (let k = kLo; k <= kHi; k++) {
                linesDrawn = true;
                lctx.setTransform(ts * dpr, 0, 0, ts * dpr, (vw / 2 + (k * W - cx) * ts) * dpr, (vh / 2 - cy * ts) * dpr);
                for (const pass of style) {
                    lctx.strokeStyle = pass.colour;
                    lctx.lineWidth = pass.width / ts;
                    lctx.setLineDash(pass.dash ? pass.dash.map(d => d / ts) : []);
                    lctx.stroke(b.path);
                }
            }
        }
    }

    // The painted map's hand-drawn mountains and hills, back to front, as the desktop draws them (MainWindow.PaintMountains, from the
    // engine's MountainSymbols): only the major peaks, once zoomed in. Each is drawn at a size on the screen worked out from the zoom
    // (MountainSymbols.Size), the named peaks first and the others as there is room: a parchment fill fading towards the foot, stipple
    // on the shadowed face, then the ridge and spur lines in ink. The data (MountainSymbols.Flat): for each, its middle, spacing, biggest
    // size, room to the water and the settlements, fill colour, unit box and point counts, then its ridge, spur and dot points (unit size).
    const smoothStep = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
    const MT_HEADER = 15, MT_REACH = 1.2, MT_ROOM = 0.5, MT_GAP = 20, MT_MIN = 8, MT_DROP = 0.35;
    function drawMountains(dpr, vw, vh, relZoom) {
        const op = smoothStep(2.2, 2.8, relZoom) * (1 - smoothStep(6.0, 8.5, relZoom));   // MountainSymbols.Opacity
        if (op <= 0.01) return;
        const m = mountains;
        const margin = 40 / ts;
        const left = cx - vw / 2 / ts - margin, right = cx + vw / 2 / ts + margin, top = cy - vh / 2 / ts - margin, bottom = cy + vh / 2 / ts + margin;
        lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lctx.setLineDash([]);
        lctx.lineJoin = "round"; lctx.lineCap = "round";
        let i = 0;
        while (i < m.length) {
            const X = m[i], Y = m[i + 1], spacing = m[i + 2], maxSize = m[i + 3], waterRoom = m[i + 4], townRoom = m[i + 5], fill = m[i + 6] | 0;
            const minY = m[i + 8], maxY = m[i + 10];
            const nR = m[i + 11], nS0 = m[i + 12], nS1 = m[i + 13], nD = m[i + 14];
            const r0 = i + MT_HEADER, s0 = r0 + 2 * nR, s1 = s0 + 2 * nS0, d0 = s1 + 2 * nS1;
            i = d0 + 2 * nD;
            if (Y < top || Y > bottom) continue;
            // MountainSymbols.Size and Fade
            const gap = spacing * ts;
            if (gap < MT_GAP) continue;
            const size = Math.min(maxSize, MT_ROOM * gap, waterRoom * ts / MT_REACH, (townRoom * ts - 6) / MT_REACH);
            if (size < MT_MIN) continue;
            const a = op * smoothStep(MT_GAP, MT_GAP * 1.25, gap) * smoothStep(MT_MIN, MT_MIN + 2, size);
            if (a <= 0.01) continue;
            const kLo = Math.ceil((left - X) / W), kHi = Math.floor((right - X) / W);
            const lw = Math.min(2.0, Math.max(1.0, size * 0.13)), dr = Math.min(1.1, Math.max(0.45, size * 0.035));
            const dots = Math.min(nD, Math.round(size * 4));
            const fr = fill & 255, fg = (fill >> 8) & 255, fb = (fill >> 16) & 255;
            const solid = `rgba(${fr},${fg},${fb},${(0.88 * a).toFixed(3)})`;
            for (let k = kLo; k <= kHi; k++) {
                linesDrawn = true;
                const ox = vw / 2 + (X + k * W - cx) * ts, oy = vh / 2 + (Y - cy) * ts + MT_DROP * size;
                const poly = (from, count, close) => {
                    lctx.beginPath();
                    lctx.moveTo(ox + m[from] * size, oy + m[from + 1] * size);
                    for (let j = 1; j < count; j++) lctx.lineTo(ox + m[from + 2 * j] * size, oy + m[from + 2 * j + 1] * size);
                    if (close) lctx.closePath();
                };
                // the fill: solid near the top, fading to nothing at the foot (MountainSymbols.FillAlpha, FillSolidTo)
                const g = lctx.createLinearGradient(0, oy + minY * size, 0, oy + maxY * size);
                g.addColorStop(0, solid); g.addColorStop(0.375, solid); g.addColorStop(1, `rgba(${fr},${fg},${fb},0)`);
                poly(r0, nR, true);
                lctx.fillStyle = g; lctx.fill();
                // stipple
                lctx.beginPath();
                for (let j = 0; j < dots; j++) {
                    const x = ox + m[d0 + 2 * j] * size, y = oy + m[d0 + 2 * j + 1] * size;
                    lctx.moveTo(x + dr, y); lctx.arc(x, y, dr, 0, 2 * Math.PI);
                }
                lctx.fillStyle = `rgba(52,38,26,${(0.86 * a).toFixed(3)})`; lctx.fill();
                // the ridge and the spurs
                poly(r0, nR, false);
                lctx.strokeStyle = `rgba(40,28,18,${(0.94 * a).toFixed(3)})`; lctx.lineWidth = lw; lctx.stroke();
                lctx.strokeStyle = `rgba(40,28,18,${(0.86 * a).toFixed(3)})`; lctx.lineWidth = lw * 0.8;
                if (nS0 > 1) { poly(s0, nS0, false); lctx.stroke(); }
                if (nS1 > 1) { poly(s1, nS1, false); lctx.stroke(); }
            }
        }
        lctx.lineJoin = "round";
    }

    function drawLines() {
        if (!lctx) return;
        lctx.setTransform(1, 0, 0, 1, 0, 0);
        lctx.clearRect(0, 0, lineCanvas.width, lineCanvas.height);
        linesDrawn = false;
        drawLineContent();
        lineCanvas.style.visibility = linesDrawn ? "visible" : "hidden";
    }

    function drawLineContent() {
        if (!W || !lines) return;
        const dpr = lineCanvas.width / Math.max(1, host.clientWidth);
        const v = viewSize();
        const relZoom = ts * H / 512;
        lctx.lineJoin = "round";
        lctx.lineCap = "round";

        // the drawn mountains, under everything else (on the painted map)
        if (lineOpts.mountains && mountains && detailed) drawMountains(dpr, v.w, v.h, relZoom);

        // province borders: thin dashed lines inside each nation, with the political layer on (as the desktop)
        if (lineOpts.provinces && relZoom >= 2.0) {
            const fade = Math.min(1, Math.max(0, (relZoom - 2.0) / 0.9 + 0.15));
            strokeBuckets(lines.provinces, dpr, v.w, v.h, [
                { colour: `rgba(24,18,12,${0.33 * fade})`, width: 2.8 },
                { colour: `rgba(255,250,235,${0.73 * fade})`, width: 1.2, dash: [5, 3] },
            ]);
        }

        // roads and sea routes: from 500%, the main ones first (as the desktop)
        if (lineOpts.routes && ts >= 5 * fitTs - 1e-9) {
            for (const [name, st] of Object.entries(ROUTE_STYLES)) {
                if (relZoom < st.from) continue;
                const fade = Math.min(1, Math.max(0, (relZoom - st.from) / 0.6 + 0.2));
                const major = name.endsWith("Major");
                const width = (major ? 1.7 : 1.1) + Math.min(1.6, relZoom * 0.09);
                const passes = st.sea
                    ? [
                        { colour: `rgba(10,30,60,${0.235 * fade})`, width: width + 1.6 },
                        st.ferry
                            ? { colour: `rgba(255,236,170,${0.78 * fade})`, width: width * 0.85, dash: [2.5, 3.5] }
                            : { colour: `rgba(238,246,255,${0.47 * fade})`, width, dash: [7, 5] },
                    ]
                    : [
                        { colour: "rgba(52,34,16,0.745)", width: width + 1.8 },
                        { colour: "rgb(144,128,90)", width },
                    ];
                strokeBuckets(lines.routes[name], dpr, v.w, v.h, passes);
            }
        }
        // the trade along the routes, wider for the busier ones (with the trade layer, as the desktop; from the whole-world view, since
        // the flows are what the layer is for)
        if (routeTrade) {
            for (const [style, bands] of Object.entries(routeTrade)) {
                const st = ROUTE_STYLES[style];
                if (!st || relZoom < st.from) continue;
                const fade = Math.min(1, Math.max(0, (relZoom - st.from) / 0.6 + 0.2));
                for (const b of bands) strokeBuckets(b.buckets, dpr, v.w, v.h, [{ colour: `rgba(40,210,190,${0.9 * fade})`, width: b.width }]);
            }
        }
        // over them, the ones the weather slows (orange) or closes (red), as on the desktop
        if (lineOpts.routes && ts >= 5 * fitTs - 1e-9 && routeStates && lines.single) {
            for (let i = 0; i < routeStates.length; i++) {
                const state = routeStates[i], r = lines.single[i];
                if (!state || !r) continue;
                const st = ROUTE_STYLES[r.style];
                if (relZoom < st.from) continue;
                const fade = Math.min(1, Math.max(0, (relZoom - st.from) / 0.6 + 0.2));
                const width = (r.style.endsWith("Major") ? 1.7 : 1.1) + Math.min(1.6, relZoom * 0.09);
                lctx.globalAlpha = (state === 2 ? 0.92 : 0.88) * fade;
                strokeBuckets([r], dpr, v.w, v.h, [{ colour: state === 2 ? stateColours.closed : stateColours.slowed, width: width * 0.8 }]);
                lctx.globalAlpha = 1;
            }
        }
        lctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // ---------------------------------------------------------------- the close-up painted map

    const DETAIL_FROM = 1.5;           // screen pixels per tile from which the painting program takes over (as on the desktop)
    let detailed = false;              // the painted layer is the one showing
    let paint = null;                  // { prog, u, tex, info, ready, failed }
    let half = null;                   // { fbo, tex, w, h } for drawing at half resolution while moving on a slow card
    // what the painting lays over itself (see MapComposer.Overlay in C#); until told otherwise: borders, towns and rivers, no layers
    let overlay = { count: 0, kind: [], slice: [], full: [], nations: false, borders: true, settlements: true, opacity: 0.5, riverMin: 0.2186, water: true, season: 0 };
    let blit = null;                   // { prog, uT, uSize }
    let lastViewKey = "", changeTime = 0, lastDrawAt = 0, avgInterval = 16, settleTimer = 0;

    // the desktop's shader is GLSL 3.3; browsers speak GLSL ES 3.0, which needs its precision spelled out
    function toEs(src) {
        return src.replace(/^#version 330 core/m,
            "#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp usampler2D;\n" +
            "precision highp isampler2D;\nprecision highp sampler2DArray;");
    }

    function link(vs, fs) {
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        return p;
    }

    const UNITS = { uER: 1, uCol: 2, uMisc: 3, uTag: 4, uIdx: 5, uClim: 6, uCities: 7, uPlaces: 8, uNationCol: 9, uLayers: 10 };
    const UNIFORMS = ["uMode", "uView", "uCenter", "uTile", "uRenderScale", "uFadeLow", "uW", "uH", "uSea", "uScale", "uReliefGain", "uRiverMin",
        "uShowWater", "uOpacity", "uNationsOn", "uBordersOn", "uTownsOn", "uSettlementZoom", "uHouseZoom", "uSeason", "uHasVeg", "uHasIce", "uHasTemp",
        "uHasField", "uHasReed", "uHasTowns", "uHasNation", "uHasCities", "uHasPlaces", "uMinZoom", "uLayerCount", "uLayerKind", "uLayerSlice", "uLayerFull"];

    function makePaintProgram(src) {
        const p = link(VS, toEs(src));
        const u = {};
        for (const n of UNIFORMS) u[n] = gl.getUniformLocation(p, n);
        gl.useProgram(p);
        for (const [n, unit] of Object.entries(UNITS)) gl.uniform1i(gl.getUniformLocation(p, n), unit);
        // the overlay layers come with part 2 of the map; until then an empty stack (each sampler still needs a texture of its own kind)
        gl.activeTexture(gl.TEXTURE0 + UNITS.uLayers);
        const layers = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, layers);
        gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.activeTexture(gl.TEXTURE0);
        return { prog: p, u, tex: {}, layers, info: null, ready: false, failed: false };
    }

    // a typed view of bytes sent from C# (copied when they do not start on a boundary the type needs)
    function view(Type, u8) {
        const b = Type.BYTES_PER_ELEMENT;
        if (u8.byteOffset % b === 0) return new Type(u8.buffer, u8.byteOffset, u8.byteLength / b);
        return new Type(u8.slice().buffer);
    }

    function dataTex(old, unit, ifmt, fmt, type, w, h, data) {
        if (old) gl.deleteTexture(old);
        const t = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
    }

    // The world's close-up data (see PaintedForMap.cs) and the shader's source. Returns "" when all is well, or what went wrong (the
    // map then stays on the plain picture when zoomed in).
    function setPainted(src, info, er, col, misc, tags, idx, clim, cities, places, nations) {
        if (!gl) return "no graphics card";
        try {
            if (paint && paint.failed) return paint.error;
            if (!paint) paint = makePaintProgram(src);
            const t = paint.tex, w = info.w, h = info.h;
            t.er = dataTex(t.er, UNITS.uER, gl.RG32F, gl.RG, gl.FLOAT, w, h, view(Float32Array, er));
            t.col = dataTex(t.col, UNITS.uCol, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, w, h, col);
            t.misc = dataTex(t.misc, UNITS.uMisc, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, w, h, misc);
            t.tag = dataTex(t.tag, UNITS.uTag, gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, w, h, tags);
            t.idx = dataTex(t.idx, UNITS.uIdx, gl.RG16I, gl.RG_INTEGER, gl.SHORT, w, h, view(Int16Array, idx));
            t.clim = dataTex(t.clim, UNITS.uClim, gl.RG32F, gl.RG, gl.FLOAT, w, h, view(Float32Array, clim));
            t.cities = dataTex(t.cities, UNITS.uCities, gl.RGBA32F, gl.RGBA, gl.FLOAT, 1024, info.cityRows, view(Float32Array, cities));
            t.places = dataTex(t.places, UNITS.uPlaces, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 1024, info.placeRows, places);
            t.nation = dataTex(t.nation, UNITS.uNationCol, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 256, 1, nations);
            gl.activeTexture(gl.TEXTURE0);
            paint.info = info;
            paint.ready = true;
            // draw once now (off screen, tiny) so the card prepares the program while the generating screen still shows
            warmUp();
            const err = gl.getError();
            if (err !== gl.NO_ERROR) throw new Error("WebGL error " + err);
            changed();
            return "";
        } catch (e) {
            console.warn("World Builder: close-up painting is not available:", e);
            if (paint) { paint.failed = true; paint.ready = false; paint.error = String(e.message || e); }
            else paint = { failed: true, ready: false, error: String(e.message || e) };
            changed();
            return paint.error;
        }
    }

    function ensureHalf(w, h) {
        if (half && half.w === w && half.h === h) return half;
        if (!half) half = { fbo: gl.createFramebuffer(), tex: null, w: 0, h: 0 };
        if (half.tex) gl.deleteTexture(half.tex);
        half.tex = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + 11);
        gl.bindTexture(gl.TEXTURE_2D, half.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, half.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, half.tex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.activeTexture(gl.TEXTURE0);
        half.w = w; half.h = h;
        return half;
    }

    function warmUp() {
        const target = ensureHalf(8, 8);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, 8, 8);
        paintPass(8, 8, 1, Math.max(DETAIL_FROM, 8));
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.finish();
    }

    // one run of the painting program over a w x h target; dpr = target pixels per CSS pixel; z = CSS pixels per tile
    function paintPass(w, h, dpr, z) {
        const u = paint.u, i = paint.info;
        gl.useProgram(paint.prog);
        gl.bindVertexArray(vao);
        const t = paint.tex;
        const bind = (unit, tx, target) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target || gl.TEXTURE_2D, tx); };
        bind(UNITS.uER, t.er); bind(UNITS.uCol, t.col); bind(UNITS.uMisc, t.misc); bind(UNITS.uTag, t.tag); bind(UNITS.uIdx, t.idx);
        bind(UNITS.uClim, t.clim); bind(UNITS.uCities, t.cities); bind(UNITS.uPlaces, t.places); bind(UNITS.uNationCol, t.nation);
        bind(UNITS.uLayers, paint.layers, gl.TEXTURE_2D_ARRAY);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(u.uMode, 0);
        gl.uniform2f(u.uView, w, h);
        gl.uniform2f(u.uCenter, wrapX(cx), cy);
        gl.uniform1f(u.uTile, z * dpr);
        gl.uniform1f(u.uRenderScale, dpr);
        gl.uniform1f(u.uFadeLow, 0);
        gl.uniform1i(u.uW, i.w); gl.uniform1i(u.uH, i.h);
        gl.uniform1f(u.uSea, i.sea); gl.uniform1f(u.uScale, i.scale); gl.uniform1f(u.uReliefGain, i.reliefGain);
        const ov = overlay;
        gl.uniform1f(u.uRiverMin, ov.water ? ov.riverMin : -1);
        gl.uniform1i(u.uShowWater, ov.water ? 1 : 0);
        gl.uniform1f(u.uOpacity, ov.opacity);
        gl.uniform1i(u.uNationsOn, ov.nations ? 1 : 0);
        gl.uniform1i(u.uBordersOn, ov.borders ? 1 : 0);
        gl.uniform1i(u.uTownsOn, ov.settlements ? 1 : 0);
        gl.uniform1f(u.uSettlementZoom, 5 * fitTs);          // settlements from 500% (as on the desktop)
        gl.uniform1f(u.uHouseZoom, Math.max(6, 7 * fitTs));  // houses from 700%
        gl.uniform1i(u.uSeason, ov.season | 0);
        gl.uniform1i(u.uHasVeg, i.hasVeg); gl.uniform1i(u.uHasIce, i.hasIce); gl.uniform1i(u.uHasTemp, i.hasTemp);
        gl.uniform1i(u.uHasField, i.hasField); gl.uniform1i(u.uHasReed, i.hasReed); gl.uniform1i(u.uHasTowns, i.hasTowns);
        gl.uniform1i(u.uHasNation, i.hasNation); gl.uniform1i(u.uHasCities, i.hasCities); gl.uniform1i(u.uHasPlaces, i.hasPlaces);
        gl.uniform1fv(u.uMinZoom, new Float32Array(i.minZoom));
        gl.uniform1i(u.uLayerCount, ov.count | 0);
        gl.uniform1iv(u.uLayerKind, pad(Int32Array, ov.kind));
        gl.uniform1iv(u.uLayerSlice, pad(Int32Array, ov.slice));
        gl.uniform1fv(u.uLayerFull, pad(Float32Array, ov.full));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // Paints the view. While the view is moving and frames come slowly (a modest graphics card on a big screen), it paints at half the
    // resolution and stretches that over the screen, then paints it sharp once the view stops, as the desktop does.
    function drawPainted() {
        const now = performance.now();
        const key = wrapX(cx).toFixed(4) + "|" + cy.toFixed(4) + "|" + ts.toFixed(5) + "|" + canvas.width + "x" + canvas.height;
        if (key !== lastViewKey) { lastViewKey = key; changeTime = now; }
        const moving = now - changeTime < 150;
        if (moving && now - lastDrawAt < 250) avgInterval = avgInterval * 0.8 + (now - lastDrawAt) * 0.2;
        lastDrawAt = now;
        const scale = moving && avgInterval > 30 ? 0.5 : 1;
        const dpr = canvas.width / Math.max(1, host.clientWidth);
        if (scale === 1) {
            paintPass(canvas.width, canvas.height, dpr, ts);
            return;
        }
        const w = Math.max(1, Math.ceil(canvas.width * scale)), h = Math.max(1, Math.ceil(canvas.height * scale));
        const target = ensureHalf(w, h);
        gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        paintPass(w, h, dpr * scale, ts);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        if (!blit) {
            const p = link(VS, `#version 300 es
precision highp float;
uniform sampler2D uT;
uniform vec2 uSize;
out vec4 o;
void main() { o = texture(uT, gl_FragCoord.xy / uSize); }`);
            blit = { prog: p, uT: gl.getUniformLocation(p, "uT"), uSize: gl.getUniformLocation(p, "uSize") };
        }
        gl.useProgram(blit.prog);
        gl.activeTexture(gl.TEXTURE0 + 11);
        gl.bindTexture(gl.TEXTURE_2D, target.tex);
        gl.uniform1i(blit.uT, 11);
        gl.uniform2f(blit.uSize, canvas.width, canvas.height);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.activeTexture(gl.TEXTURE0);
        // once the view has been still for a moment, paint it again at full sharpness
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => { dirty = true; kick(); }, 170);
    }

    function pad(Type, values) { const a = new Type(12); (values || []).slice(0, 12).forEach((v, i) => a[i] = v); return a; }

    // The layers laid over the close-up painting (see MapComposer.Overlay): their settings, and their colours one after another
    // (each world-sized, RGBA), which go on the card as one stack of layers.
    function setOverlay(o, slices) {
        overlay = o;
        if (paint && !paint.failed && paint.info) {
            const w = paint.info.w, h = paint.info.h, n = Math.max(1, o.sliceCount | 0);
            gl.activeTexture(gl.TEXTURE0 + UNITS.uLayers);
            gl.deleteTexture(paint.layers);
            paint.layers = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D_ARRAY, paint.layers);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            if ((o.sliceCount | 0) > 0 && slices && slices.length >= w * h * 4 * o.sliceCount)
                gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, w, h, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, slices);
            else
                gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            gl.activeTexture(gl.TEXTURE0);
        }
        changed();
    }

    // each nation's colour (they change with the colourblind setting)
    function setNationColours(bytes) {
        if (!paint || paint.failed || !paint.tex) return;
        paint.tex.nation = dataTex(paint.tex.nation, UNITS.uNationCol, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, 256, 1, bytes);
        gl.activeTexture(gl.TEXTURE0);
        changed();
    }

    // for checking on the build machine: how a frame was last drawn
    function debugInfo() {
        return { fitTs, W, H, lines: !!lines, routesOn: lineOpts.routes, provincesOn: lineOpts.provinces, detailed, paintReady: !!(paint && paint.ready), paintFailed: !!(paint && paint.failed), ts, usingPaint: detailed && !!(paint && paint.ready) && ts >= DETAIL_FROM, avgInterval };
    }

    return { create, setWorld, setImage, setPainted, setOverlay, setLines, setLineOptions, select, setNationColours, clear, fit, goTo, getView, setView, setRouteStates, setRouteTrade, key, options, redraw, debugInfo };
})();
