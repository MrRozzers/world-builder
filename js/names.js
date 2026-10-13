// Names and markers on the map (Stage 2, part 4): city, nation, province and natural-feature names, settlement and place markers,
// port rings, sites (bridges, fords, lighthouses...), lairs and camps, and magic nodes. The layout follows the desktop's NamesLayout:
// the same order, sizes, fonts, colours and rules for what shows at which zoom, and a name that would run into one already placed
// is left out.
//
// The names are laid out for a view once it settles. While the view moves, the last layout is slid and scaled along with the map
// (as the desktop does), then laid out again a moment after it stops. map.js calls in here; this file does no moving itself.
window.wbNames = (function () {
    let host, canvas, ctx, map;        // map: what map.js lends us (view, world size, projection)
    let data = null;                   // see NamesForMap.cs
    let opts = { geo: true, regions: false, settlements: true, routes: true, magic: false, magicMode: 0, lairs: false };
    let laidFor = null;                // the view the canvas was laid out for: { cx, cy, ts, w, h }
    let timer = 0;
    let lineBoxes = [];                // bounds of each line-lettered natural feature (rivers, ranges)
    let hits = [];                     // what the last layout put where: markers { kind, index, x, y, r, tx, ty } and names { kind, index, rect }

    const CITY_FONT = "'Segoe UI', system-ui, -apple-system, sans-serif";
    const SERIF = "Georgia, 'Times New Roman', serif";
    const SETTLEMENT_MIN_ZOOM = [13, 10, 7, 4, 0];    // by kind (Settlement, Hamlet, Village, Town, City), as SettlementInfo.MinZoom
    const RIVER_NAME_MIN = 400, MINOR_RIVER_NAME_MIN = 600;
    const GEO = { Ocean: 0, Sea: 1, Continent: 2, Island: 3, MountainRange: 4, Peak: 5, River: 6, Lake: 7, Desert: 8, Forest: 9, Gulf: 10, Bay: 11, Sound: 12, Strait: 13 };

    function attach(hostElement, mapApi) {
        host = hostElement; map = mapApi;
        canvas = document.createElement("canvas");
        canvas.className = "map-names";
        host.insertBefore(canvas, host.querySelector(".map-ui"));
        ctx = canvas.getContext("2d");
    }

    function set(payload) {
        data = payload;
        prepare();
        laidFor = null;
        map.redraw();
    }

    function setOptions(o) {
        Object.assign(opts, o);
        laidFor = null;
        map.redraw();
    }

    function clear() { data = null; laidFor = null; if (ctx) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); } }

    // bounds for the line-lettered names, so a river nowhere near the screen is not worked out at all
    function prepare() {
        lineBoxes = data.geo.map(g => {
            if (!g.line || g.path.length < 4) return null;
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (let k = 0; k < g.path.length; k += 2) {
                minX = Math.min(minX, g.path[k]); maxX = Math.max(maxX, g.path[k]);
                minY = Math.min(minY, g.path[k + 1]); maxY = Math.max(maxY, g.path[k + 1]);
            }
            return { x0: g.path[0], minX, maxX, minY, maxY };
        });
    }

    // ---- called by map.js on every drawn frame ----
    function frame(v) {      // v: { cx, cy, ts, W, H, fitTs, w, h, dpr, paintTowns }
        if (!canvas) return;
        const pw = Math.round(v.w * v.dpr), ph = Math.round(v.h * v.dpr);
        if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; laidFor = null; }
        if (!data || !v.W) { canvas.style.visibility = "hidden"; return; }
        if (laidFor && laidFor.cx === v.cx && laidFor.cy === v.cy && laidFor.ts === v.ts && laidFor.w === v.w && laidFor.h === v.h && laidFor.paintTowns === v.paintTowns) {
            canvas.style.transform = "";
            return;
        }
        if (!laidFor) { layout(v); return; }
        // slide and scale the last layout with the map, and lay out again once the view has been still a moment
        const a = v.ts / laidFor.ts;
        const tx = v.w / 2 + (laidFor.cx - v.cx) * v.ts - (v.w / 2) * a;
        const ty = v.h / 2 + (laidFor.cy - v.cy) * v.ts - (v.h / 2) * a;
        canvas.style.transform = `translate(${tx}px, ${ty}px) scale(${a})`;
        clearTimeout(timer);
        timer = setTimeout(() => { timer = 0; layout(map.view()); }, 130);
    }

    // ---- the layout ----
    function layout(v) {
        laidFor = { cx: v.cx, cy: v.cy, ts: v.ts, w: v.w, h: v.h, paintTowns: v.paintTowns };
        hits = [];
        canvas.style.transform = "";
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        const relZoom = v.ts * v.H / 512;
        const zoomPct = v.ts / v.fitTs * 100;
        const placed = [];
        let drew = false;

        // where a tile is on screen: every copy of the wrapping world that is near the screen
        const project = (tx, ty, margin = 40) => {
            const out = [];
            const y = v.h / 2 + (ty + 0.5 - v.cy) * v.ts;
            if (y < -margin || y > v.h + margin) return out;
            let dx = tx + 0.5 - v.cx;
            dx -= v.W * Math.round(dx / v.W);
            for (let c = -2; c <= 2; c++) {
                const x = v.w / 2 + (dx + c * v.W) * v.ts;
                if (x >= -margin && x <= v.w + margin) out.push([x, y]);
            }
            return out;
        };

        // ---- markers first, names over them ----
        const showTowns = opts.settlements && zoomPct >= 500 - 1e-6;
        const screenCities = [];
        if (showTowns) {
            const c = data.cities;
            for (let i = 0; i < data.cityNames.length; i++) {
                const kind = c[5 * i + 2], capital = c[5 * i + 3] === 1;
                if (!capital && relZoom < SETTLEMENT_MIN_ZOOM[kind]) continue;
                for (const [x, y] of project(c[5 * i], c[5 * i + 1])) {
                    screenCities.push([i, x, y]);
                    hits.push({ kind: "city", index: i, x, y, r: 9, tx: c[5 * i], ty: c[5 * i + 1] });
                }
            }
            for (let i = 0; i < data.placeNames.length; i++)
                for (const [x, y] of project(data.places[2 * i], data.places[2 * i + 1]))
                    hits.push({ kind: "place", index: i, x, y, r: 10, tx: data.places[2 * i], ty: data.places[2 * i + 1] });
            if (!v.paintTowns) { drawCityMarkers(screenCities, v.ts); drawPlaceMarkers(project, v.ts); drew = true; }
            // a ring round each port (with the roads, as on the desktop)
            if (opts.routes && relZoom >= 1.4) { drawPortRings(screenCities); drew = true; }
        }
        if (opts.routes && relZoom >= 1.6 && drawSites(project, relZoom)) drew = true;
        if (drawMagic(project, relZoom)) drew = true;

        // ---- nation names along their land (political layer), under everything else ----
        if (opts.regions && relZoom <= 9 && data.nations.length) drew = drawNationNames(v, relZoom) || drew;

        // ---- city names: capitals first, then the other major cities, then more of the rest as you zoom in ----
        if (screenCities.length) {
            const byCity = new Map();
            for (const [i, x, y] of screenCities) { let l = byCity.get(i); if (!l) byCity.set(i, l = []); l.push([x, y]); }
            const plan = data.cityPlan, c = data.cities;
            for (let k = 0; k < plan.length; k += 2) {
                const idx = plan[k], minZoom = plan[k + 1];
                if (minZoom > relZoom) break;   // the plan is in order of appearance
                const spots = byCity.get(idx);
                if (!spots) continue;
                const capital = c[5 * idx + 3] === 1, major = minZoom <= 0;
                const size = capital ? 14.5 : major ? 12.5 : 11.5;
                ctx.font = `bold ${size}px ${CITY_FONT}`;
                const name = data.cityNames[idx];
                const width = ctx.measureText(name).width, height = size;
                const gap = capital ? 8 : 6;
                for (const [x, y] of spots) {
                    const options = [
                        [x + gap, y - height * 0.55, x + gap + width, y + height * 0.45],
                        [x - gap - width, y - height * 0.55, x - gap, y + height * 0.45],
                        [x - width / 2, y - gap - height, x + width / 2, y - gap],
                        [x - width / 2, y + gap, x + width / 2, y + gap + height],
                    ];
                    for (const r of options) {
                        if (r[0] < 0 || r[2] > v.w || r[1] < 0 || r[3] > v.h) continue;
                        if (clashes(placed, r, 3, 1)) continue;
                        placed.push(r);
                        text(name, r[0], r[3] - height * 0.18, "rgb(252,250,244)", "rgba(24,18,12,0.92)", 3.4);
                        drew = true;
                        break;
                    }
                }
            }
        }

        // ---- province names, once the provinces can be seen ----
        if (opts.regions && relZoom >= 3 && relZoom <= 16 && data.provinces.length) {
            const alpha = clamp(Math.min((relZoom - 3) / 0.8 + 0.15, (16 - relZoom) / 3 + 0.15), 0, 1);
            ctx.font = `italic 12.5px ${SERIF}`;
            for (const p of data.provinces) {
                for (const [x, y] of project(p.x, p.y)) {
                    const width = ctx.measureText(p.text).width, height = 12.5;
                    const r = [x - width / 2, y - height * 0.55, x + width / 2, y + height * 0.45];
                    if (r[0] < 0 || r[2] > v.w || r[1] < 0 || r[3] > v.h) continue;
                    if (clashes(placed, r, 3, 2)) continue;
                    placed.push(r);
                    hits.push({ kind: "province", index: p.id, rect: r });
                    text(p.text, r[0], r[3] - height * 0.18, `rgba(${p.colour},${0.94 * alpha})`, `rgba(20,14,8,${0.78 * alpha})`, 3);
                    drew = true;
                }
            }
        }

        // ---- names of oceans, mountains, rivers and the rest ----
        if (opts.geo && data.geo.length) drew = drawGeoNames(v, relZoom, zoomPct, project, placed) || drew;

        canvas.style.visibility = drew ? "visible" : "hidden";
    }

    function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

    function clashes(placed, r, padX, padY) {
        for (const p of placed)
            if (r[0] < p[2] + padX && r[2] + padX > p[0] && r[1] < p[3] + padY && r[3] + padY > p[1]) return true;
        return false;
    }

    function text(s, x, y, fill, halo, haloWidth) {
        ctx.strokeStyle = halo; ctx.lineWidth = haloWidth; ctx.strokeText(s, x, y);
        ctx.fillStyle = fill; ctx.fillText(s, x, y);
    }

    function markerLabel(name, x, y) {
        ctx.font = `bold 11.5px ${CITY_FONT}`;
        const w = ctx.measureText(name).width;
        text(name, x - w / 2, y, "rgb(252,250,244)", "rgba(24,18,12,0.92)", 3.4);
    }

    // ---- settlement and place markers (when the close-up painting is not drawing them itself), and port rings ----
    const CITY_FILL = ["rgb(168,150,120)", "rgb(204,190,164)", "rgb(226,214,190)", "rgb(240,236,224)", "rgb(245,245,240)"];
    const SIZE_FACTOR = [0.42, 0.5, 0.62, 0.8, 1.0];

    function drawCityMarkers(spots, zoom) {
        const c = data.cities;
        for (const [i, x, y] of spots) {
            const kind = c[5 * i + 2], capital = c[5 * i + 3] === 1;
            const radius = (2 + 0.5 * Math.sqrt(zoom)) * (capital ? 1.5 : SIZE_FACTOR[kind]);
            const ring = kind >= 3 || capital ? 1.3 : 1.0;
            ctx.beginPath(); ctx.arc(x, y, radius + ring, 0, Math.PI * 2); ctx.fillStyle = "rgb(30,24,20)"; ctx.fill();
            ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fillStyle = capital ? "rgb(250,220,90)" : CITY_FILL[kind]; ctx.fill();
        }
    }

    function drawPlaceMarkers(project, zoom) {
        const radius = 3.2 + 0.6 * Math.sqrt(zoom), ring = 1.3;
        for (let i = 0; i < data.placeNames.length; i++) {
            const col = data.placeColours[i];
            for (const [x, y] of project(data.places[2 * i], data.places[2 * i + 1])) {
                diamond(x, y, radius + ring, "rgb(30,24,20)");
                diamond(x, y, radius, `rgb(${col & 255},${(col >> 8) & 255},${(col >> 16) & 255})`);
            }
        }
    }

    function diamond(x, y, r, fill) {
        ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
        ctx.fillStyle = fill; ctx.fill();
    }

    const RING_RADIUS = [6, 4.5, 5.2, 6, 7, 7.5];   // by harbour grade: none, landing stage, dock, harbour, port, great port

    let closedPorts = new Set();     // ports the weather has closed (their ring turns red, as on the desktop)
    function setClosedPorts(list) { closedPorts = new Set(list || []); laidFor = null; if (map) map.redraw(); }

    function drawPortRings(spots) {
        const c = data.cities;
        for (const [i, x, y] of spots) {
            const grade = c[5 * i + 4];
            if (!grade) continue;
            ctx.strokeStyle = closedPorts.has(i) ? "rgba(236,60,50,0.94)" : "rgba(150,215,255,0.9)";
            let rad = RING_RADIUS[grade];
            if (c[5 * i + 3] === 1) rad += 1.2;
            ctx.lineWidth = grade <= 2 ? 1.1 : grade >= 4 ? 2.0 : 1.6;
            ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.stroke();
            if (grade === 5) { ctx.beginPath(); ctx.arc(x, y, rad + 3, 0, Math.PI * 2); ctx.stroke(); }
        }
    }

    // ---- sites: bridges, fords, river ferries, lighthouses, sea forts and passes (as the desktop draws them) ----
    const SITE = { Bridge: 0, Ford: 1, RiverFerry: 2, Lighthouse: 3, SeaFort: 4, Pass: 5 };
    function siteMinZoom(kind, guarded) {
        if (kind === SITE.SeaFort || kind === SITE.Pass) return guarded || kind === SITE.SeaFort ? 1.6 : 2.4;
        if (kind === SITE.Lighthouse) return 2.0;
        if (kind === SITE.Bridge) return guarded ? 2.6 : 3.4;
        return 3.4;
    }

    function drawSites(project, relZoom) {
        const s = data.sites;
        let drew = false;
        for (let i = 0; i < data.siteNames.length; i++) {
            const kind = s[4 * i + 2], guarded = s[4 * i + 3] === 1;
            if (relZoom < siteMinZoom(kind, guarded)) continue;
            for (const [x, y] of project(s[4 * i], s[4 * i + 1])) {
                hits.push({ kind: "site", index: i, x, y, r: 9, tx: s[4 * i], ty: s[4 * i + 1] });
                drawSite(kind, guarded, x, y, 5.5);
                if (relZoom >= 6) markerLabel(data.siteNames[i], x, y + 5.5 + 12);
                drew = true;
            }
        }
        return drew;
    }

    function drawSite(kind, guarded, x, y, r) {
        ctx.beginPath(); ctx.arc(x, y, r + 1.2, 0, Math.PI * 2); ctx.fillStyle = "rgba(24,20,16,0.84)"; ctx.fill();
        ctx.lineWidth = 1.4;
        const poly = (pts, fill) => { ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); };
        switch (kind) {
            case SITE.Bridge:
                ctx.strokeStyle = "rgb(226,196,140)";
                ctx.beginPath(); ctx.moveTo(x - r * 0.75, y + r * 0.35); ctx.quadraticCurveTo(x, y - r * 0.55, x + r * 0.75, y + r * 0.35); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(x - r * 0.8, y - r * 0.2); ctx.lineTo(x + r * 0.8, y - r * 0.2); ctx.stroke();
                break;
            case SITE.Ford:
                ctx.strokeStyle = "rgb(130,190,240)";
                ctx.beginPath(); ctx.moveTo(x - r * 0.8, y); ctx.bezierCurveTo(x - r * 0.4, y - r * 0.45, x, y + r * 0.45, x + r * 0.8, y - r * 0.05); ctx.stroke();
                ctx.fillStyle = "rgb(226,210,170)";
                for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.arc(x + k * r * 0.45, y + r * 0.35, 0.9, 0, Math.PI * 2); ctx.fill(); }
                break;
            case SITE.RiverFerry:
                ctx.fillStyle = "rgb(130,190,240)"; ctx.fillRect(x - r * 0.8, y + r * 0.25, r * 1.6, r * 0.2);
                poly([x - r * 0.6, y - r * 0.15, x + r * 0.6, y - r * 0.15, x + r * 0.4, y + r * 0.2, x - r * 0.4, y + r * 0.2], "rgb(226,196,140)");
                break;
            case SITE.Lighthouse:
                ctx.beginPath(); ctx.arc(x, y - r * 0.45, r * 0.75, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,220,110,0.43)"; ctx.fill();
                poly([x - r * 0.35, y + r * 0.7, x - r * 0.18, y - r * 0.35, x + r * 0.18, y - r * 0.35, x + r * 0.35, y + r * 0.7], "rgb(250,248,240)");
                ctx.beginPath(); ctx.arc(x, y - r * 0.5, r * 0.22, 0, Math.PI * 2); ctx.fillStyle = "rgb(255,210,70)"; ctx.fill();
                break;
            case SITE.SeaFort:
                ctx.fillStyle = "rgb(200,196,188)";
                ctx.fillRect(x - r * 0.6, y - r * 0.25, r * 1.2, r * 0.9);
                for (let k = 0; k < 3; k++) ctx.fillRect(x - r * 0.6 + k * r * 0.45, y - r * 0.55, r * 0.3, r * 0.32);
                ctx.fillStyle = "rgb(200,60,50)"; ctx.fillRect(x - r * 0.12, y + r * 0.2, r * 0.24, r * 0.45);
                break;
            case SITE.Pass:
                poly([x - r * 0.85, y + r * 0.55, x - r * 0.35, y - r * 0.45, x, y + r * 0.05, x + r * 0.35, y - r * 0.45, x + r * 0.85, y + r * 0.55], "rgb(236,236,240)");
                ctx.strokeStyle = "rgb(176,140,90)";
                ctx.beginPath(); ctx.moveTo(x - r * 0.5, y + r * 0.45); ctx.lineTo(x + r * 0.5, y + r * 0.45); ctx.stroke();
                if (guarded) { ctx.fillStyle = "rgb(200,60,50)"; ctx.fillRect(x - r * 0.05, y - r * 0.85, r * 0.45, r * 0.3); }
                break;
        }
    }

    // ---- magic nodes (magic layer) and lairs and camps (danger view, or markers alone) ----
    function drawMagic(project, relZoom) {
        let drew = false;
        if (opts.magic && opts.magicMode !== 2) {
            const n = data.nodes;
            for (let i = 0; i < data.nodeNames.length; i++) {
                const r = 6 + 5 * n[3 * i + 2];
                for (const [x, y] of project(n[3 * i], n[3 * i + 1])) {
                    hits.push({ kind: "node", index: i, x, y, r: r + 3, tx: n[3 * i], ty: n[3 * i + 1] });
                    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = "rgba(255,240,255,0.92)"; ctx.fill();
                    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(150,70,230,0.94)"; ctx.stroke();
                    ctx.beginPath(); ctx.arc(x, y, r * 0.45, 0, Math.PI * 2); ctx.fillStyle = "rgb(150,70,230)"; ctx.fill();
                    if (relZoom >= 1.4) markerLabel(data.nodeNames[i], x, y + r + 12);
                    drew = true;
                }
            }
        }
        if ((opts.magic && opts.magicMode === 2) || opts.lairs) {
            const c = data.camps;
            for (let i = 0; i < data.campNames.length; i++) {
                const r = 6 + 1.4 * c[3 * i + 2], col = data.campColours[i];
                for (const [x, y] of project(c[3 * i], c[3 * i + 1])) {
                    hits.push({ kind: "camp", index: i, x, y, r: r + 3, tx: c[3 * i], ty: c[3 * i + 1] });
                    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
                    ctx.fillStyle = `rgba(${col & 255},${(col >> 8) & 255},${(col >> 16) & 255},0.96)`; ctx.fill();
                    ctx.lineWidth = 2; ctx.strokeStyle = "rgba(20,12,12,0.9)"; ctx.stroke();
                    ctx.font = `bold ${r * 1.25}px ${CITY_FONT}`;
                    const g = data.campGlyphs[i], gw = ctx.measureText(g).width;
                    ctx.fillStyle = "#fff"; ctx.fillText(g, x - gw / 2, y + r * 1.25 * 0.36);
                    if (relZoom >= 1.6) markerLabel(data.campNames[i], x, y + r + 12);
                    drew = true;
                }
            }
        }
        return drew;
    }

    // ---- lettering along a line (the desktop's LabelPaths) ----
    function smooth(xs, ys, rounds = 2) {
        let x = xs.slice(), y = ys.slice();
        if (x.length >= 2 && x[x.length - 1] < x[0]) { x.reverse(); y.reverse(); }
        for (let round = 0; round < rounds && x.length >= 3; round++) {
            const nx = [x[0]], ny = [y[0]];
            for (let i = 0; i < x.length - 1; i++) {
                nx.push(0.75 * x[i] + 0.25 * x[i + 1]); ny.push(0.75 * y[i] + 0.25 * y[i + 1]);
                nx.push(0.25 * x[i] + 0.75 * x[i + 1]); ny.push(0.25 * y[i] + 0.75 * y[i + 1]);
            }
            nx.push(x[x.length - 1]); ny.push(y[y.length - 1]);
            x = nx; y = ny;
        }
        return [x, y];
    }

    function pathLength(xs, ys) { let t = 0; for (let i = 1; i < xs.length; i++) t += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]); return t; }

    function fit(xs, ys, textLength, left, top, right, bottom) {
        if (xs.length < 2 || textLength <= 0) return null;
        const [sx, sy] = smooth(xs, ys);
        const n = sx.length;
        let bestStart = -1, bestEnd = -1, bestLen = 0, runStart = -1;
        for (let i = 0; i <= n; i++) {
            const inside = i < n && sx[i] >= left && sx[i] <= right && sy[i] >= top && sy[i] <= bottom;
            if (inside && runStart < 0) runStart = i;
            if ((!inside || i === n) && runStart >= 0) {
                const end = i - 1;
                let len = 0;
                for (let k = runStart + 1; k <= end; k++) len += Math.hypot(sx[k] - sx[k - 1], sy[k] - sy[k - 1]);
                if (len > bestLen) { bestLen = len; bestStart = runStart; bestEnd = end; }
                runStart = -1;
            }
        }
        if (bestStart < 0 || bestLen < textLength) return null;
        const cum = new Float64Array(bestEnd - bestStart + 1);
        for (let k = 1; k < cum.length; k++) {
            const a = bestStart + k - 1, b = bestStart + k;
            cum[k] = cum[k - 1] + Math.hypot(sx[b] - sx[a], sy[b] - sy[a]);
        }
        const from = cum[cum.length - 1] / 2 - textLength / 2, to = from + textLength;
        const px = [], py = [];
        for (let k = 0; k < cum.length - 1; k++) {
            const a = cum[k], b = cum[k + 1];
            if (b < from || a > to) continue;
            const i0 = bestStart + k, i1 = i0 + 1;
            const t0 = Math.max(0, (from - a) / (b - a)), t1 = Math.min(1, (to - a) / (b - a));
            if (px.length === 0) { px.push(sx[i0] + (sx[i1] - sx[i0]) * t0); py.push(sy[i0] + (sy[i1] - sy[i0]) * t0); }
            px.push(sx[i0] + (sx[i1] - sx[i0]) * t1); py.push(sy[i0] + (sy[i1] - sy[i0]) * t1);
        }
        if (px.length < 2) return null;
        let maxTurn = 0;
        for (let i = 2; i < px.length; i++) {
            const ax = px[i - 1] - px[i - 2], ay = py[i - 1] - py[i - 2], bx = px[i] - px[i - 1], by = py[i] - py[i - 1];
            const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
            if (la < 0.001 || lb < 0.001) continue;
            maxTurn = Math.max(maxTurn, Math.acos(clamp((ax * bx + ay * by) / (la * lb), -1, 1)));
        }
        if (maxTurn > 1.75) return null;
        return [px, py];
    }

    // puts text along a line, letter by letter, halo first then fill, the middle of the letters riding on the line
    function drawAlongPath(s, px, py, size, fill, halo, haloWidth) {
        const cum = [0];
        for (let i = 1; i < px.length; i++) cum.push(cum[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]));
        const total = cum[cum.length - 1];
        const at = d => {
            let i = 1;
            while (i < cum.length - 1 && cum[i] < d) i++;
            const seg = cum[i] - cum[i - 1] || 1, t = clamp((d - cum[i - 1]) / seg, 0, 1);
            return [px[i - 1] + (px[i] - px[i - 1]) * t, py[i - 1] + (py[i] - py[i - 1]) * t, Math.atan2(py[i] - py[i - 1], px[i] - px[i - 1])];
        };
        const glyphs = [];
        let d = 0;
        for (const ch of s) {
            const w = ctx.measureText(ch).width;
            if (d + w / 2 > total + 1) break;
            glyphs.push([ch, w, at(d + w / 2)]);
            d += w;
        }
        const down = size * 0.34;
        for (const pass of [0, 1]) {
            for (const [ch, w, [x, y, ang]] of glyphs) {
                ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
                if (pass === 0) { ctx.strokeStyle = halo; ctx.lineWidth = haloWidth; ctx.strokeText(ch, -w / 2, down); }
                else { ctx.fillStyle = fill; ctx.fillText(ch, -w / 2, down); }
                ctx.restore();
            }
        }
    }

    // a line in tiles (x continuous) as screen lines for each copy of the world near the screen
    function screenPaths(v, path) {
        const n = path.length / 2;
        let baseDx = path[0] - v.cx;
        baseDx -= v.W * Math.round(baseDx / v.W);
        const out = [];
        for (let c = -2; c <= 2; c++) {
            const xs = new Array(n), ys = new Array(n);
            let minX = Infinity, maxX = -Infinity;
            for (let k = 0; k < n; k++) {
                xs[k] = v.w / 2 + (baseDx + (path[2 * k] - path[0]) + c * v.W) * v.ts;
                ys[k] = v.h / 2 + (path[2 * k + 1] - v.cy) * v.ts;
                minX = Math.min(minX, xs[k]); maxX = Math.max(maxX, xs[k]);
            }
            if (maxX < -20 || minX > v.w + 20) continue;
            out.push([xs, ys]);
        }
        return out;
    }

    function drawNationNames(v, relZoom) {
        const fade = relZoom <= 5.5 ? 1 : clamp((9 - relZoom) / 3.5, 0, 1);
        if (fade <= 0) return false;
        const taken = [];
        let drew = false;
        for (const nat of data.nations) {
            ctx.font = `bold 12px ${SERIF}`;
            const w12 = ctx.measureText(nat.text).width;
            for (const [xs, ys] of screenPaths(v, nat.path)) {
                const [smx, smy] = smooth(xs, ys);
                const full = pathLength(smx, smy);
                let size = clamp(12 * (0.72 * full / w12), 11, 40);
                let length = w12 * size / 12;
                let f = fit(xs, ys, length, 4, 4, v.w - 4, v.h - 4);
                if (!f) { size *= 0.7; length *= 0.7; if (size < 10) continue; f = fit(xs, ys, length, 4, 4, v.w - 4, v.h - 4); }
                if (!f) continue;
                const [fx, fy] = f;
                const box = [Math.min(...fx), Math.min(...fy) - size * 0.6, Math.max(...fx), Math.max(...fy) + size * 0.6];
                if (taken.some(t => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1])) continue;
                taken.push(box);
                hits.push({ kind: "nation", index: nat.id, rect: box });
                ctx.font = `bold ${size}px ${SERIF}`;
                // spread the letters to the fitted length (the measured width at this size)
                drawAlongPath(nat.text, fx, fy, size, `rgba(${nat.colour},${0.92 * fade})`, `rgba(20,14,8,${0.82 * fade})`, 3.2);
                drew = true;
            }
        }
        return drew;
    }

    function maybeVisible(v, box) {
        if (!box) return true;
        const y0 = v.h / 2 + (box.minY - v.cy) * v.ts, y1 = v.h / 2 + (box.maxY - v.cy) * v.ts;
        if (y1 < -20 || y0 > v.h + 20) return false;
        let baseDx = box.x0 - v.cx;
        baseDx -= v.W * Math.round(baseDx / v.W);
        for (let c = -2; c <= 2; c++) {
            const x0 = v.w / 2 + (baseDx + (box.minX - box.x0) + c * v.W) * v.ts, x1 = v.w / 2 + (baseDx + (box.maxX - box.x0) + c * v.W) * v.ts;
            if (x1 >= -20 && x0 <= v.w + 20) return true;
        }
        return false;
    }

    function drawGeoNames(v, relZoom, zoomPct, project, placed) {
        let drew = false;
        for (let gi = 0; gi < data.geo.length; gi++) {
            const g = data.geo[gi];
            if (relZoom < g.minZoom || relZoom > g.maxZoom) continue;
            if (g.kind === GEO.River && zoomPct < (g.majorRiver ? RIVER_NAME_MIN : MINOR_RIVER_NAME_MIN)) continue;
            if (g.line && !maybeVisible(v, lineBoxes[gi])) continue;
            const spots = project(g.x, g.y);
            if (!spots.length && !g.line) continue;

            let alpha = 1;
            if (g.minZoom > 0) alpha = Math.min(alpha, (relZoom - g.minZoom) / 0.35 + 0.15);
            alpha = clamp(Math.min(alpha, (g.maxZoom - relZoom) / 0.8 + 0.15), 0, 1);
            if (alpha < 0.08) continue;
            const fill = `rgba(${g.colour},${alpha * (g.water ? 0.88 : 0.94)})`;
            const halo = g.water ? `rgba(12,30,58,${alpha * 0.745})` : `rgba(30,20,10,${alpha * 0.843})`;

            // rivers and ranges are lettered along their own line when it is long enough on screen
            if (g.line) {
                const range = g.kind === GEO.MountainRange;
                const along = range ? [...g.text.toUpperCase()].join(" ") : g.text;
                const size = range ? g.size * 0.95 : g.size;
                ctx.font = `italic bold ${size}px ${SERIF}`;
                const need = ctx.measureText(along).width;
                let lettered = false;
                for (const [xs, ys] of screenPaths(v, g.path)) {
                    const f = fit(xs, ys, need, 4, 4, v.w - 4, v.h - 4);
                    if (!f) continue;
                    const [fx, fy] = f;
                    const box = [Math.min(...fx), Math.min(...fy) - size * 0.6, Math.max(...fx), Math.max(...fy) + size * 0.6];
                    if (clashes(placed, box, 0, 0)) continue;
                    placed.push(box);
                    hits.push({ kind: "geo", index: g.index, rect: box });
                    drawAlongPath(along, fx, fy, size, fill, halo, 3);
                    lettered = drew = true;
                }
                if (lettered) continue;
            }

            ctx.font = `italic bold ${g.size}px ${SERIF}`;
            const width = ctx.measureText(g.text).width, height = g.size;
            const marker = g.kind === GEO.Peak;
            for (const [x, y] of spots) {
                let left = marker ? x + 7 : x - width / 2;
                const top = y - height * 0.55;
                const r = [left, top, left + width, top + height];
                if (!marker) {   // slide a name centred near the edge back onto the screen
                    if (r[0] < 4) { r[2] += 4 - r[0]; r[0] = 4; }
                    if (r[2] > v.w - 4) { r[0] -= r[2] - (v.w - 4); r[2] = v.w - 4; }
                }
                if (r[0] < 0 || r[2] > v.w || r[1] < 0 || r[3] > v.h) continue;
                if (clashes(placed, r, 4, 2)) continue;
                placed.push(r);
                hits.push({ kind: "geo", index: g.index, rect: r });
                if (marker) {
                    ctx.beginPath(); ctx.arc(x, y, 4.2, 0, Math.PI * 2); ctx.fillStyle = `rgba(30,20,10,${alpha * 0.9})`; ctx.fill();
                    ctx.beginPath(); ctx.arc(x, y, 2.8, 0, Math.PI * 2); ctx.fillStyle = `rgba(${g.colour},${alpha})`; ctx.fill();
                }
                text(g.text, r[0], r[3] - height * 0.2, fill, halo, 3);
                drew = true;
            }
        }
        return drew;
    }

    // What is under a point on screen (CSS pixels from the map's top left), as the desktop picks it: lairs and nodes, then
    // settlements, places and sites, then names (the smallest where names overlap). Null when nothing is.
    function hitAt(x, y) {
        if (!laidFor || canvas.style.transform) return null;    // the layout is being slid along with a moving map: wait for it
        const order = { camp: 0, node: 1, city: 2, place: 3, site: 4 };
        let best = null, bestScore = Infinity;
        for (const h of hits) {
            if (h.rect) continue;
            const d = Math.hypot(h.x - x, h.y - y);
            if (d > h.r) continue;
            const score = order[h.kind] * 1000 + d;
            if (score < bestScore) { bestScore = score; best = h; }
        }
        if (best) return best;
        let bestArea = Infinity;
        for (const h of hits) {
            if (!h.rect) continue;
            const r = h.rect, pad = 2;
            if (x < r[0] - pad || x > r[2] + pad || y < r[1] - pad || y > r[3] + pad) continue;
            const area = (r[2] - r[0]) * (r[3] - r[1]) + (h.kind === "geo" ? 0 : 1e7);   // a feature's name before a region's
            if (area < bestArea) { bestArea = area; best = h; }
        }
        return best;
    }

    return { attach, set, setOptions, setClosedPorts, clear, frame, hitAt };
})();
