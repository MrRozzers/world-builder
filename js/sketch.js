// Settlement sketches on city cards (Stage 3, part 2): the engine's plan of a settlement (SketchForMap.cs) drawn as the desktop's
// SettlementSketch draws it, on a canvas in the card, sharp at any screen scale. Hovering a lettered building rings it in gold and names
// it in a small label on the sketch (nothing changes size or moves, so the card stays still); clicking one tells C# (OnSketchBuilding)
// so its card opens beside the settlement's.
window.wbSketch = (() => {
    "use strict";

    const W = 320, H = 240;   // sketch units (SettlementPlan.W and H)
    const K = { Field: 0, Wood: 1, Rock: 2, District: 3, Green: 4, Square: 5, Street: 6, Road: 7, House: 8, BurntHouse: 9, Water: 10, River: 11, Wall: 12, Limit: 13, Pier: 14, Ship: 15, Bridge: 16, Gate: 17 };
    const FIELDS = ["rgb(196,206,140)", "rgb(208,196,130)", "rgb(186,200,150)", "rgb(204,210,150)"];
    const DISTRICTS = ["rgb(226,214,190)", "rgb(214,222,200)", "rgb(224,208,204)", "rgb(206,214,226)", "rgb(230,224,196)",
        "rgb(218,206,222)", "rgb(204,226,214)", "rgb(228,214,206)", "rgb(216,220,196)", "rgb(222,206,196)"];
    const GLYPHS = { T: "rgb(150,110,200)", K: "rgb(190,60,60)", M: "rgb(214,150,40)", V: "rgb(90,160,80)", I: "rgb(180,110,60)", S: "rgb(110,110,120)",
        W: "rgb(70,130,180)", H: "rgb(40,120,170)", A: "rgb(140,70,200)", B: "rgb(120,90,90)", O: "rgb(100,100,100)", w: "rgb(70,130,180)",
        F: "rgb(150,130,60)", "=": "rgb(120,90,60)", C: "rgb(90,90,110)" };
    const glyphColour = g => GLYPHS[g] || "rgb(160,120,80)";
    const FONT = 'bold {s}px "Segoe UI", system-ui, sans-serif';
    const ROOFS = ["rgb(176,96,78)", "rgb(164,86,70)", "rgb(186,112,84)", "rgb(156,104,82)"];

    const sketches = new WeakMap();   // canvas -> { plan, dotnet, live, hover, ro }

    // Draws a plan on a canvas (re-drawn when the canvas changes size). live: a hidden element that names the building picked, for
    // screen readers.
    function draw(canvas, plan, dotnet, live) {
        if (!canvas) return;
        let s = sketches.get(canvas);
        if (!s) {
            s = { plan: null, dotnet: null, live: null, hover: -1 };
            s.ro = new ResizeObserver(() => paint(canvas));
            s.ro.observe(canvas);
            canvas.addEventListener("pointermove", e => onMove(canvas, e));
            canvas.addEventListener("pointerleave", () => setHover(canvas, -1));
            canvas.addEventListener("click", e => onClick(canvas, e));
            canvas.addEventListener("keydown", e => onKey(canvas, e));
            sketches.set(canvas, s);
        }
        s.plan = plan; s.dotnet = dotnet; s.live = live; s.hover = -1;
        paint(canvas);
    }

    function paint(canvas) {
        const s = sketches.get(canvas);
        if (!s || !s.plan) return;
        const cssW = canvas.clientWidth || 300, cssH = cssW * H / W;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const pw = Math.round(cssW * dpr), ph = Math.round(cssH * dpr);
        if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
        const ctx = canvas.getContext("2d");
        ctx.setTransform(pw / W, 0, 0, ph / H, 0, 0);
        render(ctx, s.plan, s.hover);
    }

    function poly(ctx, p, a, b, close) {
        ctx.beginPath();
        for (let i = a; i + 1 < b; i += 2) { if (i === a) ctx.moveTo(p[i], p[i + 1]); else ctx.lineTo(p[i], p[i + 1]); }
        if (close) ctx.closePath();
    }

    function render(ctx, plan, hover) {
        const p = plan.pts, n = plan.kinds.length;
        ctx.lineCap = "round"; ctx.lineJoin = "round";
        ctx.setLineDash([]);
        ctx.fillStyle = "rgb(214,224,178)";
        ctx.fillRect(0, 0, W, H);
        const fill = c => { ctx.fillStyle = c; ctx.fill(); };
        const stroke = (c, w) => { ctx.strokeStyle = c; ctx.lineWidth = w; ctx.stroke(); };

        for (let i = 0; i < n; i++) {
            const a = plan.starts[i], b = plan.starts[i + 1], tag = plan.tags[i];
            switch (plan.kinds[i]) {
                case K.Field: {   // a field with its furrows along its length, and a hedge round it
                    poly(ctx, p, a, b, true); fill(FIELDS[tag & 3]);
                    if (b - a >= 8) {
                        ctx.save(); ctx.clip();
                        const ux = p[a + 2] - p[a], uy = p[a + 3] - p[a + 1], ul = Math.hypot(ux, uy) || 1;
                        const vx = p[a + 6] - p[a], vy = p[a + 7] - p[a + 1], vl = Math.hypot(vx, vy) || 1;
                        ctx.beginPath();
                        for (let t = 2.2; t < vl; t += 2.6) {
                            const ox = p[a] + vx / vl * t, oy = p[a + 1] + vy / vl * t;
                            ctx.moveTo(ox - ux / ul * 2, oy - uy / ul * 2); ctx.lineTo(ox + ux * 1.05, oy + uy * 1.05);
                        }
                        ctx.strokeStyle = "rgba(110,120,60,.28)"; ctx.lineWidth = .45; ctx.stroke();
                        ctx.restore();
                        poly(ctx, p, a, b, true);
                    }
                    stroke("rgb(120,140,80)", .9);
                    break;
                }
                case K.Wood: ctx.beginPath(); ctx.arc(p[a], p[a + 1], p[a + 2], 0, Math.PI * 2); fill("rgb(70,120,70)"); break;
                case K.Rock: poly(ctx, p, a, b, true); fill("rgb(150,146,140)"); stroke("rgb(100,96,90)", .6); break;
                case K.District: poly(ctx, p, a, b, true); fill(DISTRICTS[tag % DISTRICTS.length]); break;
                case K.Green: poly(ctx, p, a, b, true); fill("rgb(150,190,120)"); stroke("rgb(120,110,80)", .5); break;
                case K.Square: poly(ctx, p, a, b, true); fill("rgb(226,204,150)"); stroke("rgb(120,110,80)", .5); break;
                case K.Street:   // tag 1: a village's street or lanes, a dirt track; otherwise a town's paved street
                    poly(ctx, p, a, b, false);
                    if (tag === 1) { stroke("rgb(150,128,92)", 3.2); stroke("rgb(206,186,140)", 2.2); }
                    else { stroke("rgb(128,114,94)", 1.9); stroke("rgb(232,222,200)", 1.1); }
                    break;
                case K.Road: poly(ctx, p, a, b, false); stroke("rgb(176,150,100)", 2.6); break;
                case K.House: case K.BurntHouse: {
                    const burnt = plan.kinds[i] === K.BurntHouse;
                    const col = burnt ? "rgb(120,110,100)" : ROOFS[(Math.floor(p[a] * 7.3 + p[a + 1] * 13.1) & 0x7fffffff) % ROOFS.length];
                    if (b - a === 3) {
                        ctx.beginPath(); ctx.arc(p[a], p[a + 1], p[a + 2], 0, Math.PI * 2); fill(col); stroke("rgb(90,60,50)", .35);
                        ctx.beginPath(); ctx.arc(p[a], p[a + 1], p[a + 2] * .28, 0, Math.PI * 2); fill("rgba(70,40,30,.55)");
                        break;
                    }
                    const x = p[a], y = p[a + 1], w = p[a + 2], h = p[a + 3], ang = p[a + 4], c = Math.cos(ang), sn = Math.sin(ang);
                    ctx.beginPath();
                    [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].forEach(([u, v], k) => {
                        const px = x + u * c - v * sn, py = y + u * sn + v * c;
                        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                    });
                    ctx.closePath();
                    ctx.save(); ctx.translate(.55, .55); fill("rgba(60,40,30,.32)"); ctx.restore();   // a shadow edge
                    fill(col); stroke("rgb(90,60,50)", .4);
                    if (!burnt) {   // the roof's ridge, along the house's length
                        const r = w * .38;
                        ctx.beginPath(); ctx.moveTo(x - r * c, y - r * sn); ctx.lineTo(x + r * c, y + r * sn); stroke("rgba(80,40,30,.5)", .35);
                    }
                    break;
                }
                case K.Water:   // a sandy shore, the water, and a paler shallow edge
                    poly(ctx, p, a, b, true); stroke("rgb(226,214,166)", 6); fill("rgb(96,150,200)"); stroke("rgb(132,180,218)", 2.4);
                    break;
                case K.River:
                    poly(ctx, p, a, b, false); stroke("rgb(196,196,150)", tag + 2.4); stroke("rgb(96,150,200)", tag); stroke("rgba(140,186,222,.6)", Math.max(1, tag * .35));
                    break;
                case K.Wall:
                    poly(ctx, p, a, b, false);
                    if (tag !== 0) { stroke("rgb(110,80,50)", 1.6); break; }
                    stroke("rgb(70,60,60)", 3);
                    towers(ctx, p, a, b);
                    break;
                case K.Limit: ctx.setLineDash([3, 3]); poly(ctx, p, a, b, false); stroke("rgb(120,110,90)", .8); ctx.setLineDash([]); break;
                case K.Pier: poly(ctx, p, a, b, false); stroke("rgb(120,90,60)", tag === 1 ? 1.4 : 2.2); break;
                case K.Ship: {
                    const x = p[a], y = p[a + 1], L = tag === 1 ? 1.3 : 3, B = tag === 1 ? .6 : 1.5;   // half the desktop's pixel sizes: one sketch unit is two of its pixels
                    const ca = b - a > 2 ? Math.cos(p[a + 2]) : 1, sa = b - a > 2 ? Math.sin(p[a + 2]) : 0;
                    const pt = (u, v) => [x + u * ca - v * sa, y + u * sa + v * ca];
                    ctx.beginPath(); ctx.moveTo(...pt(-L, -B)); ctx.lineTo(...pt(L, 0)); ctx.lineTo(...pt(-L, B)); ctx.closePath();
                    fill("rgb(240,240,230)"); stroke("rgb(90,70,50)", .4);
                    break;
                }
                case K.Bridge: {
                    const x = p[a], y = p[a + 1], ang = p[a + 2], l = p[a + 3] / 2, c = Math.cos(ang), sn = Math.sin(ang);
                    ctx.beginPath(); ctx.moveTo(x - c * l, y - sn * l); ctx.lineTo(x + c * l, y + sn * l);
                    if (tag === 1) { ctx.setLineDash([1.2, 1.4]); stroke("rgb(196,186,150)", 2.4); ctx.setLineDash([]); }   // a ford: stepping stones
                    else { stroke("rgb(90,70,50)", 4.2); stroke("rgb(176,140,96)", 3); }
                    break;
                }
                case K.Gate:
                    ctx.fillStyle = "rgb(70,60,60)"; ctx.fillRect(p[a] - 2.6, p[a + 1] - 2.6, 5.2, 5.2);
                    ctx.strokeStyle = "rgb(240,220,150)"; ctx.lineWidth = .5; ctx.strokeRect(p[a] - 2.6, p[a + 1] - 2.6, 5.2, 5.2);
                    break;
            }
        }

        // district names
        ctx.font = FONT.replace("{s}", 5.6);
        ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
        for (let i = 0; i < n; i++) {
            const label = plan.labels[i];
            if (plan.kinds[i] !== K.District || !label) continue;
            const a = plan.starts[i], b = plan.starts[i + 1], m = (b - a) / 2;
            let cx = 0, cy = 0;
            for (let k = a; k + 1 < b; k += 2) { cx += p[k]; cy += p[k + 1]; }
            cx /= m; cy = cy / m + 8;
            ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.strokeText(label, cx, cy);
            ctx.fillStyle = "rgb(90,70,50)"; ctx.fillText(label, cx, cy);
        }

        // the castle's curtain wall and the temple's walls, under their letters
        for (let i = 0; i < plan.glyphs.length; i++) footprint(ctx, plan.glyphs[i], plan.markerXY[2 * i], plan.markerXY[2 * i + 1]);

        // the notable buildings, lettered
        for (let i = 0; i < plan.glyphs.length; i++) {
            const g = plan.glyphs[i], x = plan.markerXY[2 * i], y = plan.markerXY[2 * i + 1];
            const r = g === "K" ? 9 : 7;
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(x - r, y - r, 2 * r, 2 * r, 3); else ctx.rect(x - r, y - r, 2 * r, 2 * r);
            ctx.fillStyle = glyphColour(g); ctx.fill();
            ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke();
            ctx.fillStyle = "#fff"; ctx.font = FONT.replace("{s}", r * 1.25); ctx.textAlign = "center";
            ctx.fillText(g, x, y + r * 1.25 * .36);
        }
        // in a saved picture, buildings sharing a letter are numbered to match the key (G1, G2...)
        if (plan._num) for (let i = 0; i < plan.glyphs.length; i++) {
            const n = plan._num[i]; if (!n) continue;
            const g = plan.glyphs[i], x = plan.markerXY[2 * i], y = plan.markerXY[2 * i + 1], r = g === "K" ? 9 : 7;
            ctx.beginPath(); ctx.arc(x + r, y + r, 3.6, 0, Math.PI * 2); ctx.fillStyle = "rgb(40,32,24)"; ctx.fill();
            ctx.strokeStyle = "#fff"; ctx.lineWidth = .6; ctx.stroke();
            ctx.fillStyle = "#fff"; ctx.font = FONT.replace("{s}", 4.6); ctx.textAlign = "center"; ctx.fillText(String(n), x + r, y + r + 1.6);
        }
        scaleAndNorth(ctx, plan);
        if (hover >= 0 && hover < plan.glyphs.length) label(ctx, plan, hover);
    }

    // round towers along a stone wall, about every 22 sketch units
    function towers(ctx, p, a, b) {
        let run = 11;
        ctx.fillStyle = "rgb(70,60,60)";
        for (let i = a + 2; i + 1 < b; i += 2) {
            const dx = p[i] - p[i - 2], dy = p[i + 1] - p[i - 1];
            run += Math.hypot(dx, dy);
            if (run >= 22) { run = 0; ctx.beginPath(); ctx.arc(p[i], p[i + 1], 2.4, 0, Math.PI * 2); ctx.fill(); }
        }
    }

    function footprint(ctx, g, x, y) {
        ctx.lineWidth = .6; ctx.strokeStyle = "rgb(70,60,55)";
        if (g === "K") {   // a curtain wall with a tower at each corner, round a courtyard
            ctx.beginPath(); ctx.rect(x - 13, y - 11, 26, 22); ctx.fillStyle = "rgb(196,188,172)"; ctx.fill(); ctx.lineWidth = 1.6; ctx.stroke();
            ctx.fillStyle = "rgb(150,140,128)";
            for (const [u, v] of [[-13, -11], [13, -11], [13, 11], [-13, 11]]) { ctx.beginPath(); ctx.arc(x + u, y + v, 3.2, 0, Math.PI * 2); ctx.fill(); ctx.lineWidth = .7; ctx.stroke(); }
        } else if (g === "T") {   // a long nave with its crossing and a rounded east end
            ctx.beginPath();
            ctx.rect(x - 12, y - 4.5, 21, 9); ctx.rect(x - 2, y - 10, 6, 20);
            ctx.moveTo(x + 9, y - 4.5); ctx.arc(x + 9, y, 4.5, -Math.PI / 2, Math.PI / 2);
            ctx.fillStyle = "rgb(222,214,198)"; ctx.fill("nonzero"); ctx.stroke();
        }
    }

    // a scale bar (bottom left) and the north arrow (top right)
    function scaleAndNorth(ctx, plan) {
        if (!plan.metres) return;
        // in metres, or (US customary units) in feet, then whole miles
        const ft = !!plan.imperial, perUnit = plan.metres / W * (ft ? 3.28084 : 1);
        const steps = ft ? [50, 100, 200, 250, 500, 1000, 2000, 2500, 5280, 10560] : [25, 50, 100, 200, 250, 500, 1000, 2000];
        let len = steps[0];
        for (const s of steps) if (s / perUnit <= 70) len = s;
        const u = len / perUnit, x0 = 8, y0 = H - 9;
        ctx.fillStyle = "rgba(255,252,240,.82)"; ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x0 - 4, y0 - 11, u + 8, 16, 3); else ctx.rect(x0 - 4, y0 - 11, u + 8, 16);
        ctx.fill();
        for (let k = 0; k < 4; k++) { ctx.fillStyle = k % 2 ? "rgb(250,248,240)" : "rgb(60,50,40)"; ctx.fillRect(x0 + k * u / 4, y0, u / 4, 2.4); }
        ctx.strokeStyle = "rgb(60,50,40)"; ctx.lineWidth = .4; ctx.strokeRect(x0, y0, u, 2.4);
        ctx.font = FONT.replace("{s}", 5.4); ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = "rgb(60,50,40)";
        ctx.fillText(ft ? (len >= 5280 ? `${len / 5280} mile${len > 5280 ? "s" : ""}` : `${len.toLocaleString("en-US")} ft`) : len >= 1000 ? `${len / 1000} km` : `${len} m`, x0, y0 - 2.5);
        const nx = W - 12, ny = 8;
        ctx.fillStyle = "rgba(255,252,240,.82)"; ctx.beginPath(); ctx.arc(nx, ny + 9, 8, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.moveTo(nx, ny + 2); ctx.lineTo(nx + 3.4, ny + 13); ctx.lineTo(nx, ny + 10.5); ctx.closePath(); ctx.fillStyle = "rgb(60,50,40)"; ctx.fill();
        ctx.beginPath(); ctx.moveTo(nx, ny + 2); ctx.lineTo(nx - 3.4, ny + 13); ctx.lineTo(nx, ny + 10.5); ctx.closePath(); ctx.fillStyle = "rgb(250,248,240)"; ctx.fill();
        ctx.strokeStyle = "rgb(60,50,40)"; ctx.lineWidth = .4; ctx.stroke();
        ctx.font = FONT.replace("{s}", 4.6); ctx.textAlign = "center"; ctx.fillStyle = "rgb(60,50,40)"; ctx.fillText("N", nx, ny + 19.5);
    }

    // the building pointed at: a gold ring round its letter, and its name in a label above it (below it near the top edge)
    function label(ctx, plan, i) {
        const g = plan.glyphs[i], x = plan.markerXY[2 * i], y = plan.markerXY[2 * i + 1], r = g === "K" ? 9 : 7;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x - r - 2, y - r - 2, 2 * r + 4, 2 * r + 4, 4.5); else ctx.rect(x - r - 2, y - r - 2, 2 * r + 4, 2 * r + 4);
        ctx.strokeStyle = "rgba(20,16,10,.85)"; ctx.lineWidth = 3; ctx.stroke();
        ctx.strokeStyle = "rgb(255,205,70)"; ctx.lineWidth = 1.6; ctx.stroke();
        const text = plan.names[i];
        ctx.font = FONT.replace("{s}", 8);
        const tw = ctx.measureText(text).width, pad = 3, bw = tw + 2 * pad, bh = 12;
        let bx = Math.min(Math.max(2, x - bw / 2), W - bw - 2);
        let by = y - r - 5 - bh;
        if (by < 2) by = y + r + 5;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 3); else ctx.rect(bx, by, bw, bh);
        ctx.fillStyle = "rgba(20,16,10,.88)"; ctx.fill();
        ctx.fillStyle = "#fff"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillText(text, bx + pad, by + bh / 2 + .5);
        ctx.textBaseline = "alphabetic";
    }

    // the lettered building under a point (CSS pixels on the canvas), as the desktop's MarkerAt: the nearest within 11 sketch units
    function markerAt(canvas, e) {
        const s = sketches.get(canvas);
        if (!s || !s.plan) return -1;
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width * W, y = (e.clientY - rect.top) / rect.height * H;
        let best = -1, bestD = 11 * 11;
        for (let i = 0; i < s.plan.glyphs.length; i++) {
            const dx = s.plan.markerXY[2 * i] - x, dy = s.plan.markerXY[2 * i + 1] - y, d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = i; }
        }
        return best;
    }

    function setHover(canvas, i) {
        const s = sketches.get(canvas);
        if (!s || s.hover === i) return;
        s.hover = i;
        canvas.style.cursor = i >= 0 ? "pointer" : "";
        if (s.live) s.live.textContent = i >= 0 ? `${s.plan.glyphs[i]}: ${s.plan.names[i]}` : "";
        paint(canvas);
    }

    function onMove(canvas, e) { setHover(canvas, markerAt(canvas, e)); }

    function open(canvas, i) {
        const s = sketches.get(canvas);
        if (!s || i < 0 || !s.dotnet) return;
        s.dotnet.invokeMethodAsync("OnSketchBuilding", s.plan.buildings[i]).catch(() => { });
    }

    function onClick(canvas, e) { open(canvas, markerAt(canvas, e)); }

    // keyboard: arrows move between the lettered buildings, Enter opens one
    function onKey(canvas, e) {
        const s = sketches.get(canvas);
        if (!s || !s.plan || !s.plan.glyphs.length) return;
        const n = s.plan.glyphs.length;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") { setHover(canvas, (s.hover + 1) % n); e.preventDefault(); e.stopPropagation(); }
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { setHover(canvas, (s.hover - 1 + n) % n); e.preventDefault(); e.stopPropagation(); }
        else if ((e.key === "Enter" || e.key === " ") && s.hover >= 0) { open(canvas, s.hover); e.preventDefault(); }
    }

    function forget(canvas) {
        const s = canvas && sketches.get(canvas);
        if (s) { s.ro.disconnect(); s.plan = null; s.dotnet = null; sketches.delete(canvas); }
    }

    // the sketch as a picture to keep or print: the settlement drawn large, with its name and a key of the lettered buildings beside it
    function picture(plan) {
        const S = 5, KEY = 560, c = document.createElement("canvas");
        c.width = W * S + KEY; c.height = H * S;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "rgb(250,246,234)"; ctx.fillRect(0, 0, c.width, c.height);
        const order = plan.glyphs.map((g, i) => i).sort((a, b) => plan.glyphs[a] === plan.glyphs[b] ? plan.names[a].localeCompare(plan.names[b]) : plan.glyphs[a].localeCompare(plan.glyphs[b]));
        const num = new Array(plan.glyphs.length).fill(0), seen = {};
        for (const i of order) { const g = plan.glyphs[i]; if (plan.glyphs.filter(x => x === g).length > 1) num[i] = seen[g] = (seen[g] || 0) + 1; }
        ctx.save(); ctx.setTransform(S, 0, 0, S, 0, 0); render(ctx, Object.assign({}, plan, { _num: num }), -1); ctx.restore();
        // the key
        const x0 = W * S + 36;
        let y = 64;
        ctx.fillStyle = "rgb(60,45,30)"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
        ctx.font = 'bold 40px Georgia, "Times New Roman", serif';
        ctx.fillText(plan.title || "Settlement", x0, y, KEY - 60);
        y += 22;
        ctx.fillStyle = "rgb(150,120,80)"; ctx.fillRect(x0, y, KEY - 72, 2);
        y += 46;
        const rows = order.map(i => [plan.glyphs[i] + (num[i] ? num[i] : ""), plan.names[i], plan.glyphs[i]]);
        const lh = Math.min(46, (H * S - y - 30) / Math.max(1, rows.length));
        const fs = Math.max(16, Math.min(26, lh * .58));
        for (const [tagText, name, g] of rows) {
            const r = Math.min(16, lh * .38);
            ctx.beginPath();
            if (ctx.roundRect) ctx.roundRect(x0, y - r * 1.5, 2 * r, 2 * r, 5); else ctx.rect(x0, y - r * 1.5, 2 * r, 2 * r);
            ctx.fillStyle = glyphColour(g); ctx.fill();
            ctx.fillStyle = "#fff"; ctx.font = `bold ${r * 1.25}px "Segoe UI", system-ui, sans-serif`; ctx.textAlign = "center";
            ctx.fillText(g, x0 + r, y - r * 1.5 + r + r * 1.25 * .36);
            ctx.fillStyle = "rgb(50,40,30)"; ctx.font = `bold ${fs}px "Segoe UI", system-ui, sans-serif`; ctx.textAlign = "left";
            ctx.fillText(tagText, x0 + 2 * r + 10, y - r * .5 + fs * .36);
            ctx.font = `${fs}px "Segoe UI", system-ui, sans-serif`;
            ctx.fillText(name, x0 + 2 * r + 10 + fs * 2.1, y - r * .5 + fs * .36, KEY - 2 * r - 110);
            y += lh;
        }
        return new Promise(resolve => c.toBlob(b => resolve(b), "image/png"));
    }

    async function savePng(plan, name) {
        const blob = await picture(plan);
        if (!blob) return false;
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = name; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        return true;
    }

    async function copyPng(plan) {
        try {
            if (!window.ClipboardItem || !navigator.clipboard?.write) return false;
            await navigator.clipboard.write([new ClipboardItem({ "image/png": picture(plan) })]);
            return true;
        } catch { return false; }
    }

    return { draw, forget, render, savePng, copyPng, picture };
})();
