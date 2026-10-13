// Stage 7 (7.2): the globe, as the desktop's Globe view. The world's picture (the same one the flat map shows, handed over by map.js)
// is laid on a sphere seen from straight in front, worked out for every pixel by the graphics card. Drag to turn it (the spot under the
// pointer stays under it), scroll or pinch to zoom, double-click to fly there and zoom in a step; north stays up. A click opens the card
// there, as on the flat map (map.js's dotnet calls are used, so every tool works on the globe too). Auto-rotate turns it slowly.
window.wbGlobe = (() => {
    "use strict";

    const VS = `#version 300 es
    layout(location = 0) in vec2 aPos;
    void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

    const FS = `#version 300 es
    precision highp float;
    uniform sampler2D uTex;
    uniform vec2 uCenter;      // the globe's centre on the canvas, in device pixels (y up)
    uniform float uR;          // its radius in device pixels
    uniform float uLon0, uLat0;
    uniform vec3 uBack, uGlow;
    out vec4 outColor;
    const float PI = 3.14159265358979;
    void main() {
        vec2 p = (gl_FragCoord.xy - uCenter) / uR;
        float r2 = dot(p, p);
        float edge = 1.5 / uR;
        if (r2 > 1.0) {
            // a soft glow of air round the rim, fading into the background
            float d = sqrt(r2) - 1.0;
            float g = exp(-d * 18.0) * 0.55;
            outColor = vec4(mix(uBack, uGlow, g), 1.0);
            return;
        }
        float z = sqrt(1.0 - r2);
        float cl = cos(uLat0), sl = sin(uLat0);
        float y2 = p.y * cl + z * sl;
        float z2 = -p.y * sl + z * cl;
        float lat = asin(clamp(y2, -1.0, 1.0));
        float lon = uLon0 + atan(p.x, z2);
        vec2 uv = vec2(fract(lon / (2.0 * PI)), clamp((PI * 0.5 - lat) / PI, 0.0, 1.0));
        vec3 c = texture(uTex, uv).rgb;
        float shade = 0.72 + 0.28 * z;
        c *= shade;
        float rim = smoothstep(1.0, 1.0 - edge * 2.0, sqrt(r2));
        outColor = vec4(mix(mix(uBack, uGlow, 0.55), c, rim), 1.0);
    }`;

    let host = null, canvas = null, gl = null, prog = null, tex = null, loc = {}, dotnet = null, ui = {};
    let W = 0, H = 0, image = null, imageDirty = false;
    let on = false, lon0 = 0, lat0 = 0, R = 0, rot = false, frame = 0, last = 0;
    let glide = null;
    let back = [0.05, 0.07, 0.09], glow = [0.45, 0.62, 0.85];

    const dpr = () => window.devicePixelRatio || 1;
    const minR = () => 0.25 * Math.min(canvas.clientWidth, canvas.clientHeight) * dpr();
    const maxR = () => 60 * Math.min(canvas.clientWidth, canvas.clientHeight) * dpr();
    const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.motion === "reduce";

    function attach(hostElement, dotnetRef) {
        if (host === hostElement && gl) return true;
        host = hostElement; dotnet = dotnetRef;
        canvas = document.createElement("canvas");
        canvas.className = "map-globe";
        canvas.setAttribute("aria-label", "Globe. Drag to turn it, scroll or pinch to zoom, double-click to fly there.");
        canvas.hidden = true;
        host.appendChild(canvas);
        gl = canvas.getContext("webgl2", { alpha: false, antialias: true });
        if (!gl) return false;
        const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
        prog = gl.createProgram();
        gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        for (const n of ["uTex", "uCenter", "uR", "uLon0", "uLat0", "uBack", "uGlow"]) loc[n] = gl.getUniformLocation(prog, n);
        const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
        const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

        // its own controls: zoom, auto-rotate, back to the flat map
        ui.box = document.createElement("div"); ui.box.className = "globe-ui"; ui.box.hidden = true; host.appendChild(ui.box);
        const btn = (text, title, click, cls) => { const b = document.createElement("button"); b.type = "button"; b.className = cls || "map-btn"; b.textContent = text; b.title = title; b.setAttribute("aria-label", title); b.addEventListener("click", click); ui.box.appendChild(b); return b; };
        btn("−", "Zoom out", () => zoomBy(1 / 1.6));
        btn("+", "Zoom in", () => zoomBy(1.6));
        ui.rot = btn("⟳", "Turn the globe slowly (auto-rotate)", () => { rot = !rot; ui.rot.classList.toggle("on", rot); kick(); });
        ui.tip = document.createElement("div"); ui.tip.className = "map-tip globe-tip"; ui.tip.hidden = true; host.appendChild(ui.tip);

        listen();
        new MutationObserver(() => { readTheme(); kick(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        new ResizeObserver(() => { if (on) kick(); }).observe(host);
        return true;
    }

    // the world's picture (from map.js); uploaded to the graphics card when the globe is shown
    function setImage(iw, ih, rgba, worldW, worldH) {
        image = { iw, ih, rgba };
        W = worldW; H = worldH;
        imageDirty = true;
        if (on) kick();
    }

    function upload() {
        if (!image || !gl) return;
        gl.activeTexture(gl.TEXTURE0);
        if (!tex) tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, image.iw, image.ih, 0, gl.RGBA, gl.UNSIGNED_BYTE, image.rgba);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        imageDirty = false;
    }

    function readTheme() {
        const cs = getComputedStyle(document.documentElement);
        const rgb = s => { const c = document.createElement("canvas").getContext("2d"); c.fillStyle = s; const h = c.fillStyle; if (h[0] === "#") return [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16) / 255); const m = h.match(/[\d.]+/g); return m ? m.slice(0, 3).map(v => v / 255) : back; };
        back = rgb(cs.getPropertyValue("--map").trim() || "#0d1117");
        glow = document.documentElement.dataset.theme === "light" ? [0.55, 0.68, 0.85] : [0.35, 0.55, 0.85];
    }

    // shows or hides the globe; it opens looking at a spot (the flat map's centre), and hands its centre back when it closes
    function show(visible, x, y) {
        if (!canvas) return null;
        on = !!visible;
        canvas.hidden = !on; ui.box.hidden = !on; ui.tip.hidden = true;
        host.classList.toggle("globe-on", on);
        if (on) {
            readTheme();
            if (W > 0 && typeof x === "number") { lon0 = (x + 0.5) / W * 2 * Math.PI; lat0 = clampLat(Math.PI / 2 - (y + 0.5) / H * Math.PI); }
            if (!R) R = 0.42 * Math.min(canvas.clientWidth || 800, canvas.clientHeight || 600) * dpr();
            kick();
            return null;
        }
        return center();
    }

    function center() {
        if (!W) return null;
        let lon = lon0 / (2 * Math.PI); lon -= Math.floor(lon);
        return { x: lon * W - 0.5, y: (Math.PI / 2 - lat0) / Math.PI * H - 0.5 };
    }

    const clampLat = v => Math.max(-1.45, Math.min(1.45, v));

    function kick() { if (!frame) { last = performance.now(); frame = requestAnimationFrame(draw); } }

    function draw(t) {
        frame = 0;
        if (!on || !gl) return;
        const dt = Math.min(0.1, (t - last) / 1000); last = t;
        const d = dpr();
        const cw = Math.round(canvas.clientWidth * d), ch = Math.round(canvas.clientHeight * d);
        if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
        if (imageDirty) upload();
        if (glide) {
            const k = Math.min(1, (t - glide.start) / glide.dur), e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
            lon0 = glide.lon + glide.dLon * e; lat0 = glide.lat + (glide.toLat - glide.lat) * e; R = glide.r * Math.pow(glide.toR / glide.r, e);
            if (k >= 1) glide = null;
        }
        if (rot && !dragging && !reduceMotion()) lon0 += dt * 0.12;
        gl.viewport(0, 0, cw, ch);
        gl.useProgram(prog);
        gl.uniform1i(loc.uTex, 0);
        gl.uniform2f(loc.uCenter, cw / 2, ch / 2);
        gl.uniform1f(loc.uR, R);
        gl.uniform1f(loc.uLon0, lon0);
        gl.uniform1f(loc.uLat0, lat0);
        gl.uniform3f(loc.uBack, back[0], back[1], back[2]);
        gl.uniform3f(loc.uGlow, glow[0], glow[1], glow[2]);
        if (tex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); }
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        if (glide || (rot && !reduceMotion())) kick();
    }

    // the tile under a point on the canvas (CSS pixels), or null off the globe
    function pick(px, py) {
        if (!W) return null;
        const d = dpr();
        const x = (px * d - canvas.width / 2) / R, y = -(py * d - canvas.height / 2) / R;
        const r2 = x * x + y * y;
        if (r2 > 1) return null;
        const z = Math.sqrt(1 - r2), cl = Math.cos(lat0), sl = Math.sin(lat0);
        const y2 = y * cl + z * sl, z2 = -y * sl + z * cl;
        const lat = Math.asin(Math.max(-1, Math.min(1, y2)));
        let lon = (lon0 + Math.atan2(x, z2)) / (2 * Math.PI); lon -= Math.floor(lon);
        const tx = Math.floor(lon * W), ty = Math.floor((Math.PI / 2 - lat) / Math.PI * H);
        return [Math.min(W - 1, Math.max(0, tx)), Math.min(H - 1, Math.max(0, ty)), lon, lat];
    }

    // screen pixels per tile near the middle of the globe (for the card picking, as the flat map gives it)
    const tilePx = () => R / dpr() * 2 * Math.PI / Math.max(1, W);

    function zoomBy(f) {
        glide = null;
        R = Math.max(minR(), Math.min(maxR(), R * f));
        kick();
    }

    function goTo(x, y) {
        if (!on || !W) return;
        const toLon = (x + 0.5) / W * 2 * Math.PI, toLat = clampLat(Math.PI / 2 - (y + 0.5) / H * Math.PI);
        let dLon = toLon - lon0; dLon -= 2 * Math.PI * Math.round(dLon / (2 * Math.PI));
        const toR = Math.max(R, 1.4 * Math.min(canvas.clientWidth, canvas.clientHeight) * dpr());
        if (reduceMotion()) { lon0 = toLon; lat0 = toLat; R = toR; kick(); return; }
        glide = { lon: lon0, dLon, lat: lat0, toLat, r: R, toR, start: performance.now(), dur: 700 };
        kick();
    }

    // ---------------------------------------------------------------- pointer and wheel

    let dragging = false, downAt = null, moved = false, grab = null;
    const pointers = new Map();
    let pinch = null, hoverTimer = 0, hoverSeq = 0;

    function local(e) { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

    function listen() {
        canvas.addEventListener("pointerdown", e => {
            canvas.setPointerCapture(e.pointerId);
            pointers.set(e.pointerId, local(e));
            glide = null;
            if (pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), r: R };
                return;
            }
            const [x, y] = local(e);
            dragging = true; moved = false; downAt = [x, y];
            grab = { lon: lon0, lat: lat0, x, y };
            ui.tip.hidden = true;
        });
        canvas.addEventListener("pointermove", e => {
            const p = local(e);
            if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
            if (pinch && pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                R = Math.max(minR(), Math.min(maxR(), pinch.r * Math.hypot(a[0] - b[0], a[1] - b[1]) / Math.max(1, pinch.d)));
                kick(); return;
            }
            if (dragging && grab) {
                if (Math.abs(p[0] - downAt[0]) + Math.abs(p[1] - downAt[1]) > 4) moved = true;
                const k = dpr() / R;
                lon0 = grab.lon - (p[0] - grab.x) * k;
                lat0 = clampLat(grab.lat + (p[1] - grab.y) * k);
                kick(); return;
            }
            hover(p[0], p[1]);
        });
        const up = e => {
            pointers.delete(e.pointerId);
            if (pinch) { if (pointers.size < 2) pinch = null; dragging = false; return; }
            if (dragging && !moved && dotnet) {
                const hit = pick(...local(e));
                if (hit) dotnet.invokeMethodAsync("OnMapClick", "tile", -1, hit[0], hit[1], tilePx()).catch(() => { });
            }
            dragging = false; grab = null;
        };
        canvas.addEventListener("pointerup", up);
        canvas.addEventListener("pointercancel", up);
        canvas.addEventListener("pointerleave", () => { ui.tip.hidden = true; hoverSeq++; });
        canvas.addEventListener("dblclick", e => {
            const hit = pick(...local(e));
            if (!hit) return;
            const toR = Math.min(maxR(), R * 1.6);
            let dLon = hit[2] * 2 * Math.PI - lon0; dLon -= 2 * Math.PI * Math.round(dLon / (2 * Math.PI));
            glide = { lon: lon0, dLon, lat: lat0, toLat: clampLat(hit[3]), r: R, toR, start: performance.now(), dur: reduceMotion() ? 1 : 500 };
            kick();
        });
        canvas.addEventListener("wheel", e => {
            e.preventDefault();
            glide = null;
            R = Math.max(minR(), Math.min(maxR(), R * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015))));
            kick();
        }, { passive: false });
        canvas.addEventListener("contextmenu", e => {
            e.preventDefault();
            const hit = pick(...local(e));
            if (hit && dotnet) dotnet.invokeMethodAsync("OnMapContext", hit[0], hit[1], -1, e.clientX, e.clientY).catch(() => { });
        });
    }

    // a note about what is under the pointer, as on the flat map (asked of C# after a short pause)
    function hover(x, y) {
        clearTimeout(hoverTimer);
        const seq = ++hoverSeq;
        hoverTimer = setTimeout(async () => {
            const hit = pick(x, y);
            if (!hit || !dotnet) { ui.tip.hidden = true; return; }
            let lines;
            try { lines = await dotnet.invokeMethodAsync("OnMapHover", "tile", -1, hit[0], hit[1]); } catch { return; }
            if (seq !== hoverSeq || !lines) return;
            const text = lines.filter(l => l && l.length).join("\n");
            if (!text) { ui.tip.hidden = true; return; }
            ui.tip.textContent = text;
            ui.tip.hidden = false;
            ui.tip.style.whiteSpace = "pre-line";
            ui.tip.style.left = (x + 14) + "px"; ui.tip.style.top = (y + 16) + "px";
        }, 220);
    }

    return { attach, setImage, show, goTo, center, active: () => on, redraw: kick, readTheme };
})();
