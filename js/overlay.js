// What the clock and the party put over the map (Stage 5, part 1), drawn as the desktop draws them: storms with their tracks (solid
// where they have been, dashed where they are forecast to go) and a turning spiral, weather hazards at provincial seats, the travel
// planner's journey, and the party's banner with the road ahead of it. Positions come from C# (DmOverlay.cs) in tiles; map.js calls
// frame() on every drawn frame with the view. hitAt() tells map.js what is under the pointer.
window.wbOverlay = (() => {
    "use strict";

    let host = null, canvas = null, ctx = null, map = null;
    let weather = null;        // { storms, hazards, show }
    let party = null;          // { x, y, inTown, ahead, name }
    let plan = null;           // { legs, dashed, fromX, fromY, fromName, toX, toY, toName }
    let show = true;           // storms, hazards and closures on the map
    let measure = null;        // the measuring tool (Stage 7): { ax, ay, bx, by, text }, bx < 0 while the second place is not picked
    let pins = [];             // your own pins (Stage 6): { id, x, y, glyph, r, g, b, name, open }
    let hits = [];             // { kind, index, x, y, r }
    const FONT = 'bold {s}px "Segoe UI", system-ui, sans-serif';

    function attach(hostElement, mapApi) {
        host = hostElement; map = mapApi;
        canvas = document.createElement("canvas");
        canvas.className = "map-overlay";
        canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;";
        host.insertBefore(canvas, host.querySelector(".map-ui"));
        ctx = canvas.getContext("2d");
    }

    function setWeather(w) { weather = w; map && map.redraw(); }
    function setStorms(storms) { if (weather) weather.storms = storms; else weather = { storms, hazards: [] }; map && map.redraw(); }
    function setParty(p) { party = p; map && map.redraw(); }
    function setPlan(p) { plan = p; map && map.redraw(); }
    function setShow(on) { show = !!on; map && map.redraw(); }
    function setMeasure(m) { measure = m || null; map && map.redraw(); }
    function setPins(p) { pins = (p && p.pins) || []; map && map.redraw(); }
    function clear() { weather = null; party = null; plan = null; measure = null; hits = []; map && map.redraw(); }

    function frame(v) {
        if (!canvas) return;
        const pw = Math.round(v.w * v.dpr), ph = Math.round(v.h * v.dpr);
        if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, pw, ph);
        hits = [];
        if (!v.W) return;
        ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        const relZoom = v.ts * v.H / 512;
        // screen position of a tile point in the copy of the world nearest the view (plus k whole worlds)
        const sx = (x, k) => v.w / 2 + (x + k * v.W - v.cx) * v.ts;
        const sy = y => v.h / 2 + (y - v.cy) * v.ts;
        const near = x => { let dx = x - v.cx; dx -= v.W * Math.round(dx / v.W); return v.cx + dx; };
        const copies = (minX, maxX, pad) => {   // which copies of a shape (x unwrapped) reach the screen
            const x0 = v.cx - v.w / 2 / v.ts - pad, x1 = v.cx + v.w / 2 / v.ts + pad, out = [];
            for (let k = Math.ceil((x0 - maxX) / v.W); k <= Math.floor((x1 - minX) / v.W); k++) out.push(k);
            return out;
        };
        const polyline = (pts, k) => {
            ctx.beginPath();
            for (let i = 0; i + 1 < pts.length; i += 2) { const x = sx(pts[i], k), y = sy(pts[i + 1]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
        };
        const bounds = pts => { let a = Infinity, b = -Infinity; for (let i = 0; i < pts.length; i += 2) { a = Math.min(a, pts[i]); b = Math.max(b, pts[i]); } return [a, b]; };
        // a line that may cross the world's edge, shifted so it starts near the view
        const shifted = pts => {
            if (!pts || pts.length < 2) return pts || [];
            const d = near(pts[0]) - pts[0];
            if (d === 0) return pts;
            const out = pts.slice();
            for (let i = 0; i < out.length; i += 2) out[i] += d;
            return out;
        };
        const text = (s, x, y, size) => {
            ctx.font = FONT.replace("{s}", size);
            ctx.lineWidth = 3.2; ctx.strokeStyle = "rgba(20,16,12,.92)"; ctx.strokeText(s, x, y);
            ctx.fillStyle = "#fff"; ctx.fillText(s, x, y);
        };

        // hazards at the provincial seats, once provinces are big enough to tell apart
        if (show && weather && weather.hazards && relZoom >= 1.1) {
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            for (const h of weather.hazards) {
                for (const k of copies(h.x, h.x, 1)) {
                    const x = sx(h.x, k), y = sy(h.y) - 12;
                    if (x < -20 || x > v.w + 20 || y < -20 || y > v.h + 20) continue;
                    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
                    ctx.fillStyle = h.colour; ctx.fill();
                    ctx.strokeStyle = "rgba(255,255,255,.92)"; ctx.lineWidth = 1.6; ctx.stroke();
                    ctx.font = FONT.replace("{s}", 10); ctx.fillStyle = "#fff"; ctx.fillText(h.letter, x, y + .5);
                    hits.push({ kind: "hazard", index: h.provinceId, x, y, r: 10, tip: h.words });
                }
            }
            ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
        }

        // storms: tracks, then a soft disc with a spiral that turns the way the hemisphere makes it
        if (show && weather && weather.storms) {
            for (const st of weather.storms) {
                const past = shifted(st.past), ahead = shifted(st.ahead);
                const all = past.concat(ahead);
                const [minX, maxX] = all.length ? bounds(all) : [st.x, st.x];
                const r = Math.min(90, Math.max(9, st.radiusTiles * v.ts));
                for (const k of copies(minX, maxX, r / v.ts + 2)) {
                    if (past.length >= 4) {
                        polyline(past, k); ctx.setLineDash([]);
                        ctx.strokeStyle = "rgba(20,16,12,.78)"; ctx.lineWidth = 4; ctx.stroke();
                        ctx.strokeStyle = st.colour; ctx.lineWidth = 2; ctx.stroke();
                    }
                    if (ahead.length >= 4) {
                        polyline(ahead, k); ctx.setLineDash([6, 5]);
                        ctx.strokeStyle = "rgba(20,16,12,.67)"; ctx.lineWidth = 4; ctx.stroke();
                        ctx.strokeStyle = st.colour; ctx.globalAlpha = .92; ctx.lineWidth = 2; ctx.stroke(); ctx.globalAlpha = 1;
                        ctx.setLineDash([]);
                    }
                }
                const cxw = near(st.x);
                for (const k of copies(cxw, cxw, r / v.ts + 2)) {
                    const cx = sx(cxw, k), cy = sy(st.y);
                    if (cx < -r - 20 || cx > v.w + r + 20 || cy < -r - 20 || cy > v.h + r + 20) continue;
                    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
                    ctx.fillStyle = st.colour; ctx.globalAlpha = .27; ctx.fill(); ctx.globalAlpha = 1;
                    ctx.beginPath();
                    for (let i = 0; i <= 26; i++) {
                        const f = i / 26, ang = st.turn * (f * 4.4 + 0.3) + st.spin * st.turn, rr = r * (0.12 + 0.88 * f);
                        const x = cx + Math.cos(ang) * rr, y = cy + Math.sin(ang) * rr;
                        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                    }
                    ctx.strokeStyle = "rgba(20,16,12,.86)"; ctx.lineWidth = 4.2; ctx.stroke();
                    ctx.strokeStyle = "rgba(255,255,255,.96)"; ctx.lineWidth = 2.2; ctx.stroke();
                    ctx.beginPath(); ctx.arc(cx, cy, 3.2, 0, Math.PI * 2); ctx.fillStyle = st.colour; ctx.fill();
                    text(st.label, cx + r + 3, cy + 4, 11);
                    hits.push({ kind: "storm", index: st.id, x: cx, y: cy, r: Math.max(r, 14) });
                }
            }
        }

        // the travel planner's journey: gold, solid on roads and dashed on the sea and overland, a green start and a red end
        if (plan && plan.legs && plan.legs.length) {
            // join the legs into one continuous line so it never jumps at the world's edge
            const joined = [];
            let ux = null, px = 0;
            const legLines = plan.legs.map(leg => {
                const out = [];
                for (let i = 0; i + 1 < leg.length; i += 2) {
                    const tx = leg[i], ty = leg[i + 1];
                    if (ux === null) ux = tx;
                    else { let dx = tx - px; if (dx > v.W / 2) dx -= v.W; else if (dx < -v.W / 2) dx += v.W; ux += dx; }
                    px = tx;
                    out.push(ux, ty); joined.push(ux, ty);
                }
                return out;
            });
            const d = joined.length ? near(joined[0]) - joined[0] : 0;
            const [minX, maxX] = bounds(joined);
            for (const k of copies(minX + d, maxX + d, 2)) {
                legLines.forEach((pts, i) => {
                    if (pts.length < 4) return;
                    const p2 = pts.map((val, j) => j % 2 === 0 ? val + d : val);
                    polyline(p2, k); ctx.setLineDash([]);
                    ctx.strokeStyle = "rgba(20,14,6,.9)"; ctx.lineWidth = 7; ctx.stroke();
                    ctx.setLineDash(plan.dashed[i] ? [9, 6] : []);
                    ctx.strokeStyle = "rgb(255,208,60)"; ctx.lineWidth = 3.6; ctx.stroke();
                    ctx.setLineDash([]);
                });
            }
            for (const [x0, y0, name, colour] of [[plan.fromX, plan.fromY, plan.fromName, "rgb(70,200,90)"], [plan.toX, plan.toY, plan.toName, "rgb(230,60,50)"]]) {
                const xw = near(x0);
                for (const k of copies(xw, xw, 1)) {
                    const x = sx(xw, k), y = sy(y0);
                    if (x < -40 || x > v.w + 40 || y < -40 || y > v.h + 40) continue;
                    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
                    ctx.fillStyle = colour; ctx.fill();
                    ctx.strokeStyle = "rgba(255,255,255,.94)"; ctx.lineWidth = 2.2; ctx.stroke();
                    if (relZoom < 2.5) text(name, x + 10, y + 4, 12);   // closer in, the settlement's own name is on the map already
                }
            }
        }

        // the party: the road ahead (dashed gold, a ring where it ends), then a banner on a pole over where it stands
        if (party) {
            const ahead = shifted(party.ahead);
            if (ahead.length >= 4) {
                const [minX, maxX] = bounds(ahead);
                for (const k of copies(minX, maxX, 2)) {
                    polyline(ahead, k);
                    ctx.setLineDash([]); ctx.strokeStyle = "rgba(24,20,16,.78)"; ctx.lineWidth = 5; ctx.stroke();
                    ctx.setLineDash([8, 5]); ctx.strokeStyle = "rgb(255,205,70)"; ctx.lineWidth = 2.4; ctx.stroke();
                    ctx.setLineDash([]);
                    const ex = sx(ahead[ahead.length - 2], k), ey = sy(ahead[ahead.length - 1]);
                    ctx.beginPath(); ctx.arc(ex, ey, 7, 0, Math.PI * 2); ctx.fillStyle = "rgba(24,20,16,.9)"; ctx.fill();
                    ctx.strokeStyle = "rgb(255,205,70)"; ctx.lineWidth = 2.5; ctx.stroke();
                    ctx.beginPath(); ctx.arc(ex, ey, 2.2, 0, Math.PI * 2); ctx.stroke();
                }
            }
            const xw = near(party.x);
            for (const k of copies(xw, xw, 1)) {
                const x = sx(xw, k), y0 = sy(party.y), y = y0 - 13;
                if (x < -30 || x > v.w + 30 || y0 < -30 || y0 > v.h + 30) continue;
                if (!party.inTown) {
                    ctx.beginPath(); ctx.arc(x, y0, 4.5, 0, Math.PI * 2); ctx.fillStyle = "rgba(24,20,16,.9)"; ctx.fill();
                    ctx.beginPath(); ctx.arc(x, y0, 2.8, 0, Math.PI * 2); ctx.fillStyle = "rgb(255,205,70)"; ctx.fill();
                }
                ctx.beginPath(); ctx.arc(x, y, 8.5, 0, Math.PI * 2); ctx.fillStyle = "rgba(24,20,16,.9)"; ctx.fill();
                ctx.beginPath(); ctx.moveTo(x - 4, y - 6); ctx.lineTo(x + 6, y - 2.5); ctx.lineTo(x - 4, y + 1); ctx.closePath();
                ctx.fillStyle = "rgb(255,205,70)"; ctx.fill();
                ctx.beginPath(); ctx.moveTo(x - 4, y - 6); ctx.lineTo(x - 4, y + 6);
                ctx.strokeStyle = "rgb(255,205,70)"; ctx.lineWidth = 1.5; ctx.stroke();
                hits.push({ kind: "party", index: 0, x, y, r: 12 });
            }
        }

        // the measuring tool: a dashed line between the two places (the shorter way round the world), the distance at its middle
        if (measure) {
            const ax = near(measure.ax);
            let bx = measure.bx;
            if (bx >= 0) { let d = bx - ax; d -= v.W * Math.round(d / v.W); bx = ax + d; }
            for (const k of copies(Math.min(ax, bx >= 0 ? bx : ax), Math.max(ax, bx >= 0 ? bx : ax), 2)) {
                const x1 = sx(ax, k), y1 = sy(measure.ay);
                if (bx >= 0) {
                    const x2 = sx(bx, k), y2 = sy(measure.by);
                    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
                    ctx.setLineDash([]); ctx.strokeStyle = "rgba(15,12,9,.8)"; ctx.lineWidth = 5; ctx.stroke();
                    ctx.setLineDash([9, 6]); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2.2; ctx.stroke(); ctx.setLineDash([]);
                    for (const [x, y] of [[x2, y2]]) { ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = "rgba(15,12,9,.9)"; ctx.lineWidth = 2; ctx.stroke(); }
                    if (measure.text) {
                        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
                        ctx.font = FONT.replace("{s}", 13); ctx.textAlign = "center"; ctx.textBaseline = "middle";
                        ctx.lineWidth = 4; ctx.strokeStyle = "rgba(15,12,9,.85)"; ctx.strokeText(measure.text.replace(/^Distance: /, ""), mx, my - 12);
                        ctx.fillStyle = "#fff"; ctx.fillText(measure.text.replace(/^Distance: /, ""), mx, my - 12);
                        ctx.textAlign = "start"; ctx.textBaseline = "alphabetic";
                    }
                }
                ctx.beginPath(); ctx.arc(x1, y1, 5, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = "rgba(15,12,9,.9)"; ctx.lineWidth = 2; ctx.stroke();
            }
        }

        // your pins: a round head on a short stalk, the symbol in it, the name beside it when close in (or the open one)
        for (const p of pins) {
            const xw = near(p.x);
            for (const k of copies(xw, xw, 1)) {
                const x = sx(xw, k), y0 = sy(p.y), y = y0 - 18;
                if (x < -40 || x > v.w + 40 || y0 < -40 || y0 > v.h + 60) continue;
                const col = `rgb(${p.r},${p.g},${p.b})`;
                ctx.beginPath(); ctx.moveTo(x - 6, y + 5); ctx.lineTo(x, y0); ctx.lineTo(x + 6, y + 5); ctx.closePath();
                ctx.fillStyle = "rgba(20,16,12,.85)"; ctx.fill();
                ctx.beginPath(); ctx.arc(x, y, p.open ? 13 : 11.5, 0, Math.PI * 2);
                ctx.fillStyle = col; ctx.fill();
                ctx.lineWidth = p.open ? 3 : 2; ctx.strokeStyle = p.open ? "rgb(255,205,70)" : "rgba(255,255,255,.92)"; ctx.stroke();
                ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
                ctx.font = FONT.replace("{s}", 13);
                ctx.fillText(p.glyph, x, y + 0.5);
                if (p.open || relZoom >= 3) {
                    ctx.font = FONT.replace("{s}", 12); ctx.textAlign = "left";
                    ctx.lineWidth = 3.5; ctx.strokeStyle = "rgba(15,12,9,.85)"; ctx.strokeText(p.name, x + 15, y);
                    ctx.fillStyle = "#fff"; ctx.fillText(p.name, x + 15, y);
                }
                ctx.textBaseline = "alphabetic"; ctx.textAlign = "start";
                hits.push({ kind: "pin", index: p.id, x, y, r: 14, tip: p.name });
            }
        }
    }

    // what is under a point (CSS pixels in the map), nearest first; null for nothing
    function hitAt(x, y) {
        let best = null, bestD = Infinity;
        for (const h of hits) {
            const d = (h.x - x) ** 2 + (h.y - y) ** 2;
            if (d <= h.r * h.r && d < bestD) { bestD = d; best = h; }
        }
        return best;
    }

    return { attach, setWeather, setStorms, setParty, setPlan, setShow, setPins, setMeasure, clear, frame, hitAt };
})();
