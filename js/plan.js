// Stage 5, part 4: floor plans (lairs, camps, ruins, tombs, buildings, inns), drawn like the desktop's LairMapSketch: inked walls,
// hatching in the rock, numbered rooms, doors, stairs, the way in, a scale bar and a compass. C# works the plan out (the engine's
// LairMapper) and sends it here; clicks come back as plan pixels so C# can pick the room.
window.wbPlan = (function () {
    const CELL = 16, SCALE = 2;
    const STYLE = { cave: 0, fort: 1, camp: 2, tomb: 3, ruin: 4, building: 5 };
    const ink = "rgb(48,38,30)";

    function size(p) { return { w: p.cols * CELL, h: p.rows * CELL + 28 }; }

    function draw(ctx, p, grid, highlight) {
        const W = p.cols, H = p.rows, C = CELL;
        const { w: PW, h: PH } = size(p);
        const camp = p.style === STYLE.camp, cave = p.style === STYLE.cave, building = p.style === STYLE.building;
        const cell = (x, y) => p.cells[y * W + x];
        const isFloor = (x, y) => x >= 0 && y >= 0 && x < W && y < H && cell(x, y) !== 0;
        const font = px => `bold ${px}px Georgia, "Times New Roman", serif`;

        ctx.fillStyle = "rgb(231,217,184)";
        ctx.fillRect(0, 0, PW, PH);
        ctx.lineCap = "round"; ctx.lineJoin = "round";

        // a building stands in a street: cobbles outside, thick walls filling its outline
        if (building) {
            ctx.fillStyle = "rgb(214,206,186)"; ctx.fillRect(0, 0, PW, PH);
            ctx.fillStyle = "rgb(196,186,162)";
            for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if ((x + y * 3) % 4 === 0) { ctx.beginPath(); ctx.arc(x * C + 8, y * C + 8, 2.2, 0, 7); ctx.fill(); }
            for (let i = 0; i < p.foot.length; i += 4) {
                const [fx, fy, fw, fh] = [p.foot[i], p.foot[i + 1], p.foot[i + 2], p.foot[i + 3]];
                ctx.fillStyle = "rgb(92,76,60)"; ctx.fillRect(fx * C, fy * C, fw * C, fh * C);
                const label = p.footLabels[i / 4] || "";
                if (label.length) { ctx.fillStyle = ink; ctx.font = font(15); ctx.textAlign = "center"; ctx.fillText(label, (fx + fw / 2) * C, fy * C - 8); }
            }
        }

        // hatching outside the walls: short strokes in the rock within two cells of any floor
        if (!camp && !building) {
            ctx.strokeStyle = "rgba(120,100,80,0.59)"; ctx.lineWidth = 0.8;
            ctx.beginPath();
            for (let x = 0; x < W; x++)
                for (let y = 0; y < H; y++) {
                    if (isFloor(x, y)) continue;
                    let near = false;
                    for (let dx = -2; dx <= 2 && !near; dx++) for (let dy = -2; dy <= 2; dy++) if (isFloor(x + dx, y + dy)) { near = true; break; }
                    if (!near) continue;
                    const px = x * C, py = y * C;
                    for (let k = 0; k < 3; k++) { ctx.moveTo(px + 2 + k * 5, py + C - 2); ctx.lineTo(px + 8 + k * 5, py + 3); }
                }
            ctx.stroke();
        }

        // floor (a camp's ground is soft-edged: trampled earth, not walls)
        if (camp) {
            // the cells, then their outline drawn thick in the same colour with round joins: soft, rounded edges
            ctx.fillStyle = ctx.strokeStyle = "rgb(206,196,150)";
            ctx.beginPath();
            for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (isFloor(x, y)) ctx.rect(x * C, y * C, C + 0.5, C + 0.5);
            ctx.fill();
            ctx.beginPath();
            for (let x = 0; x < W; x++)
                for (let y = 0; y < H; y++) {
                    if (!isFloor(x, y)) continue;
                    const x0 = x * C, y0 = y * C, x1 = x0 + C, y1 = y0 + C;
                    if (!isFloor(x, y - 1)) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); }
                    if (!isFloor(x, y + 1)) { ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); }
                    if (!isFloor(x - 1, y)) { ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); }
                    if (!isFloor(x + 1, y)) { ctx.moveTo(x1, y0); ctx.lineTo(x1, y1); }
                }
            ctx.lineWidth = 7; ctx.stroke();
        } else {
            ctx.fillStyle = "rgb(246,238,216)";
            for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) if (isFloor(x, y)) ctx.fillRect(x * C, y * C, C + 0.5, C + 0.5);
        }

        // flagstone dots
        ctx.fillStyle = "rgba(200,188,160,0.63)";
        for (let x = 0; x < W; x++) for (let y = 0; y < H; y++)
            if (isFloor(x, y) && (x * 7 + y * 13) % 5 === 0) { ctx.beginPath(); ctx.arc(x * C + 5 + (x * 3 % 6), y * C + 6 + (y * 5 % 6), 0.9, 0, 7); ctx.fill(); }

        // fallen stone on rubble
        ctx.fillStyle = "rgb(150,136,112)";
        for (let x = 0; x < W; x++) for (let y = 0; y < H; y++)
            if (cell(x, y) === -2) {
                const px = x * C, py = y * C;
                for (const [cx, cy, r] of [[px + 4 + (x * 5 % 7), py + 5 + (y * 3 % 6), 2.6], [px + 10 - (y * 3 % 4), py + 11 - (x % 3), 2.0], [px + 7, py + 8 + (x + y) % 3, 1.5]]) {
                    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
                }
            }

        if (grid) {
            ctx.strokeStyle = "rgba(150,130,100,0.43)"; ctx.lineWidth = 0.5;
            ctx.beginPath();
            for (let x = 0; x <= W; x++) { ctx.moveTo(x * C, 0); ctx.lineTo(x * C, H * C); }
            for (let y = 0; y <= H; y++) { ctx.moveTo(0, y * C); ctx.lineTo(W * C, y * C); }
            ctx.stroke();
        }

        // walls: every floor edge that borders rock
        if (!camp) {
            ctx.beginPath();
            for (let x = 0; x < W; x++)
                for (let y = 0; y < H; y++) {
                    if (!isFloor(x, y)) continue;
                    const x0 = x * C, y0 = y * C, x1 = x0 + C, y1 = y0 + C;
                    if (!isFloor(x, y - 1)) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); }
                    if (!isFloor(x, y + 1)) { ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); }
                    if (!isFloor(x - 1, y)) { ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); }
                    if (!isFloor(x + 1, y)) { ctx.moveTo(x1, y0); ctx.lineTo(x1, y1); }
                }
            ctx.strokeStyle = ink; ctx.lineWidth = cave ? 3.2 : building ? 2.0 : 3.6;
            ctx.stroke();
        }

        // stairs: a box of treads
        for (let i = 0; i < p.stairs.length; i += 2) {
            const sx = p.stairs[i] * C + 1, sy = p.stairs[i + 1] * C + 1, s = C - 2;
            ctx.fillStyle = "rgb(250,244,226)"; ctx.fillRect(sx, sy, s, s);
            ctx.strokeStyle = ink; ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.rect(sx, sy, s, s);
            for (let k = 1; k < 4; k++) { ctx.moveTo(sx + k * s / 4, sy + 1); ctx.lineTo(sx + k * s / 4, sy + s - 1); }
            ctx.stroke();
        }

        // doors (brown; dark ones are secret)
        for (let i = 0; i < p.doors.length; i += 4) {
            const cx = p.doors[i] * C + C / 2, cy = p.doors[i + 1] * C + C / 2, horiz = p.doors[i + 2] === 1, secret = p.doors[i + 3] === 1;
            const r = horiz ? [cx - 5, cy + C / 2 - 2.5, 10, 5] : [cx + C / 2 - 2.5, cy - 5, 5, 10];
            ctx.fillStyle = secret ? ink : "rgb(150,100,60)"; ctx.fillRect(...r);
            ctx.strokeStyle = ink; ctx.lineWidth = 1; ctx.strokeRect(...r);
        }

        // the way in
        if (p.entrance.length === 2) {
            const ex = p.entrance[0] * C + C / 2, ey = p.entrance[1] * C + C / 2;
            ctx.fillStyle = "rgb(60,120,70)";
            ctx.beginPath(); ctx.moveTo(ex, ey - 8); ctx.lineTo(ex + 8, ey + 7); ctx.lineTo(ex - 8, ey + 7); ctx.closePath(); ctx.fill();
        }

        // room numbers (the chosen room ringed in gold; rooms you changed tinted)
        ctx.textAlign = "center";
        for (let i = 0; i < p.roomNo.length; i++) {
            const no = p.roomNo[i], cx = p.roomX[i] * C, cy = p.roomY[i] * C;
            if (no === highlight) { ctx.fillStyle = "rgba(255,200,60,0.78)"; ctx.beginPath(); ctx.arc(cx, cy, 21, 0, 7); ctx.fill(); }
            ctx.fillStyle = p.roomEdited[i] ? "rgb(255,236,190)" : "rgb(255,250,232)";
            ctx.beginPath(); ctx.arc(cx, cy, 15, 0, 7); ctx.fill();
            ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.stroke();
            ctx.fillStyle = ink; ctx.font = font(no >= 10 ? 17 : 21);
            ctx.fillText(String(no), cx, cy + (no >= 10 ? 6 : 7.5));
        }

        // title strip, scale bar, compass
        ctx.fillStyle = ink; ctx.textAlign = "left"; ctx.font = font(14);
        ctx.fillText(p.title, 8, H * C + 19);
        ctx.strokeStyle = ink; ctx.lineWidth = 2;
        const bx = W * C - 140, by = H * C + 16;
        ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + 4 * C, by);
        for (let i = 0; i <= 4; i++) { ctx.moveTo(bx + i * C, by - 3); ctx.lineTo(bx + i * C, by + 3); }
        ctx.stroke();
        ctx.font = font(11); ctx.fillText("20 ft", bx + 4 * C + 6, by + 4);
        const nx = W * C - 18, ny = 28;
        ctx.beginPath(); ctx.moveTo(nx, ny - 18); ctx.lineTo(nx + 6, ny + 2); ctx.lineTo(nx, ny - 3); ctx.lineTo(nx - 6, ny + 2); ctx.closePath(); ctx.fill();
        ctx.textAlign = "center"; ctx.fillText("N", nx, ny + 16);
    }

    function paint(canvas, p, grid, highlight, scale) {
        const { w, h } = size(p);
        const k = scale || SCALE;
        canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
        const ctx = canvas.getContext("2d");
        ctx.setTransform(k, 0, 0, k, 0, 0);
        draw(ctx, p, grid, highlight);
    }

    // the plan as a picture to keep: no room picked out
    // px: pixels for each 5-foot square in the picture (a VTT's grid size), or 0 for the size shown on screen
    function picture(p, grid, px) {
        const c = document.createElement("canvas");
        paint(c, p, grid, 0, px > 0 ? px / CELL : SCALE);
        return new Promise(resolve => c.toBlob(b => resolve(b), "image/png"));
    }

    // Polish: zoom and pan for phones and small windows. The box scrolls (one finger pans, as any scrolling box); two fingers pinch to
    // zoom about the point between them; Ctrl and the mouse wheel zoom too. The canvas is sized as a share of the box's width.
    function zoomable(box, canvas) {
        if (!box || !canvas || box.__zoom) return;
        const z = box.__zoom = { level: 1, start: 0, startLevel: 1 };
        const set = (level, cx, cy) => {
            level = Math.min(6, Math.max(1, level));
            const r = box.getBoundingClientRect();
            const px = cx === undefined ? r.width / 2 : cx - r.left, py = cy === undefined ? r.height / 2 : cy - r.top;
            const fx = (box.scrollLeft + px) / Math.max(1, canvas.offsetWidth), fy = (box.scrollTop + py) / Math.max(1, canvas.offsetHeight);
            z.level = level;
            canvas.style.width = (level * 100) + "%";
            box.classList.toggle("zoomed", level > 1.001);
            box.scrollLeft = fx * canvas.offsetWidth - px;
            box.scrollTop = fy * canvas.offsetHeight - py;
        };
        box.__setZoom = set;
        // pinching is read from touch events: a scrolling box hands a finger that starts to pan over to the browser (its pointer events
        // stop with pointercancel), but its touch events keep coming, so the second finger can still turn the pan into a pinch
        const pts = t => [...t].slice(0, 2).map(q => ({ x: q.clientX, y: q.clientY }));
        const gap = ([a, b]) => Math.hypot(a.x - b.x, a.y - b.y);
        box.addEventListener("touchstart", e => {
            if (e.touches.length === 2) { z.start = gap(pts(e.touches)); z.startLevel = z.level; }
        }, { passive: true });
        box.addEventListener("touchmove", e => {
            if (e.touches.length !== 2 || !(z.start > 0)) return;
            e.preventDefault();
            const two = pts(e.touches);
            set(z.startLevel * gap(two) / z.start, (two[0].x + two[1].x) / 2, (two[0].y + two[1].y) / 2);
            canvas.__noClickUntil = Date.now() + 400;
        }, { passive: false });
        const end = e => { if (e.touches.length < 2) z.start = 0; };
        box.addEventListener("touchend", end); box.addEventListener("touchcancel", end);
        box.addEventListener("wheel", e => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            set(z.level * Math.exp(-e.deltaY * 0.0025), e.clientX, e.clientY);
        }, { passive: false });
    }

    return {
        zoomable,
        // the zoom buttons: a factor to multiply by, or 0 to fit the plan to the box again
        zoom(box, factor) {
            if (!box || !box.__setZoom) return 1;
            box.__setZoom(factor > 0 ? box.__zoom.level * factor : 1);
            return box.__zoom.level;
        },
        // draws the plan on its canvas, and (once) sends clicks on it back as plan pixels
        show(canvas, p, grid, highlight, dotnet) {
            if (!canvas || !p) return;
            canvas.__plan = p;
            paint(canvas, p, grid, highlight);
            if (dotnet && !canvas.__planClick) {
                canvas.__planClick = true;
                canvas.addEventListener("click", e => {
                    if (Date.now() < (canvas.__noClickUntil || 0)) return;   // the end of a pinch, not a click on a room
                    const r = canvas.getBoundingClientRect(), q = canvas.__plan;
                    if (!q || r.width < 1 || r.height < 1) return;
                    const { w, h } = size(q);
                    dotnet.invokeMethodAsync("OnPlanClick", (e.clientX - r.left) / r.width * w, (e.clientY - r.top) / r.height * h);
                });
            }
        },
        async savePng(p, grid, name, px) {
            const blob = await picture(p, grid, px || 0);
            if (!blob) return false;
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url; a.download = name; a.rel = "noopener";
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            return true;
        },
        async copyPng(p, grid, px) {
            try {
                if (!window.ClipboardItem || !navigator.clipboard?.write) return false;
                // Safari wants the promise handed over straight away, inside the click
                await navigator.clipboard.write([new ClipboardItem({ "image/png": picture(p, grid, px || 0) })]);
                return true;
            } catch { return false; }
        },
    };
})();
