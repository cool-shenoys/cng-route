/* CNG Route: plan a drive with CNG fill stops, then get guided stop by stop.
   Data: stations.json (built by build_webapp.py). Routing: OSRM. Search: Photon. Tiles: CARTO/OSM.
   Your reports are kept on this phone (localStorage) and can be exported back to the laptop dataset. */
"use strict";

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const TIERS = ["active", "likely", "stale", "closed"];
const TIER_LABEL = {active: "Active", likely: "Likely working", stale: "Unverified", closed: "Closed"};
const EVENTS = {
  filled: "Filled", long_queue: "Long queue", no_gas: "No gas / low pressure", closed_temp: "Closed today",
  closed_permanent: "Permanently closed", not_found: "Couldn't find it", skipped: "Drove past",
};
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const nav = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;
const fmtKm = km => km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString("en-IN");
const fmtDur = m => m >= 60 ? `${Math.floor(m / 60)} h ${String(Math.round(m % 60)).padStart(2, "0")} m` : `${Math.round(m)} min`;

const LS = {
  get(k, d) { try { const v = localStorage.getItem("cng." + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem("cng." + k, JSON.stringify(v)); } catch (e) {} },
};

// ---------- state ----------
const S = Object.assign({
  places: [{label: "My location", gps: true}, null],   // first = start, last = destination
  vehicle: {range: 200, reserve: 30, fill: 100, detour: 3},
  home: null, trip: null, sheetMin: false,
}, LS.get("state", {}));
let FB = LS.get("feedback", []);
const save = () => LS.set("state", S);

let DATA = {s: [], fb: [], asof: ""}, Q = [], QID = {};
let me = null, watchId = null;

// ---------- geometry ----------
function hav(a, b) {
  const r = Math.PI / 180, p1 = a[0] * r, p2 = b[0] * r;
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((b[1] - a[1]) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

function prepLine(line) {
  const lat0 = line.reduce((a, p) => a + p[0], 0) / line.length;
  const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 111.32;
  const pts = [], ll = [];
  let last = null;
  line.forEach((p, i) => {
    const x = p[1] * kx, y = p[0] * ky;
    if (!last || i === line.length - 1 || Math.hypot(x - last[0], y - last[1]) > 0.12) { pts.push([x, y]); ll.push(p); last = [x, y]; }
  });
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return {pts, ll, cum, kx, ky, total: cum[cum.length - 1]};
}

function projSeg(L, i, x, y) {
  const [ax, ay] = L.pts[i], [bx, by] = L.pts[i + 1];
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-12;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
  const px = ax + t * dx, py = ay + t * dy;
  return {off: Math.hypot(x - px, y - py), km: L.cum[i] + t * (L.cum[i + 1] - L.cum[i])};
}

function projectPoint(L, lat, lon) {
  const x = lon * L.kx, y = lat * L.ky;
  let best = {off: Infinity, km: 0};
  for (let i = 0; i < L.pts.length - 1; i++) { const p = projSeg(L, i, x, y); if (p.off < best.off) best = p; }
  return best;
}

function corridor(L, maxOff, excluded) {
  const C = 0.1, grid = new Map();
  for (let i = 0; i < L.ll.length - 1; i++) {
    const [a, b] = [L.ll[i], L.ll[i + 1]];
    for (let gx = Math.floor(Math.min(a[0], b[0]) / C); gx <= Math.floor(Math.max(a[0], b[0]) / C); gx++)
      for (let gy = Math.floor(Math.min(a[1], b[1]) / C); gy <= Math.floor(Math.max(a[1], b[1]) / C); gy++) {
        const k = gx + ":" + gy; (grid.get(k) || grid.set(k, []).get(k)).push(i);
      }
  }
  const out = [];
  for (const q of Q) {
    if (q.dead || excluded.has(q.s.id)) continue;
    const gx = Math.floor(q.s.lat / C), gy = Math.floor(q.s.lon / C), segs = new Set();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) (grid.get((gx + dx) + ":" + (gy + dy)) || []).forEach(i => segs.add(i));
    if (!segs.size) continue;
    const x = q.s.lon * L.kx, y = q.s.lat * L.ky;
    let best = {off: Infinity};
    segs.forEach(i => { const p = projSeg(L, i, x, y); if (p.off < best.off) best = p; });
    if (best.off <= maxOff) out.push({q, km: best.km, off: best.off});
  }
  return out.sort((a, b) => a.km - b.km);
}

// ---------- station quality (tier + your reports) ----------
function quality() {
  const ev = {};
  FB.forEach(e => (ev[e.station_id] ||= []).push(e));
  Q = DATA.s.map(r => {
    const s = {id: r[0], lat: r[1], lon: r[2], tier: TIERS[r[3]], name: r[4], op: r[5], city: r[6], state: r[7], reason: r[8], src: r[9]};
    const es = (ev[s.id] || []).sort((a, b) => a.ts < b.ts ? -1 : 1), last = es[es.length - 1];
    const ag = (DATA.agg || {})[s.id] || {q: 0, f: 0, dead: 0, bad: 0};
    const dead = s.tier === "closed" || (last ? ["closed_permanent", "not_found"].includes(last.event) : !!ag.dead);
    let pen = {active: 0, likely: 1, stale: 3}[s.tier] ?? 3;
    if (es.some(e => Date.now() - Date.parse(e.ts) < 3 * 864e5 && ["no_gas", "closed_temp"].includes(e.event))) pen += 6;
    if (ag.bad) pen += 6;
    const queues = ag.q + es.filter(e => e.event === "long_queue").length, fills = ag.f + es.filter(e => e.event === "filled").length;
    pen += 1.5 * Math.min(queues, 3);
    if (fills) pen -= 0.75;
    return {s, pen, dead, queues, fills, events: es};
  });
  QID = Object.fromEntries(Q.map(q => [q.s.id, q]));
}

// ---------- planning ----------
function planStops(L, startFill, excluded) {
  const {range, reserve, detour} = S.vehicle;
  const cands = corridor(L, Math.max(detour, 8), excluded);
  let pos = 0, left = range * startFill / 100, guard = 0;
  const stops = [], gaps = [];
  while (L.total - pos > left - reserve && guard++ < 60) {
    const usable = Math.max(left - reserve, 0), reach = pos + usable;
    const minKm = stops.length ? pos + 0.3 * usable : pos + 0.3;
    const win = cands.filter(c => c.km > minKm && c.km <= reach);
    let near = win.filter(c => c.off <= detour);
    if (!near.length) near = win;
    let onPetrol = false;
    if (!near.length) {
      const nxt = cands.find(c => c.km > Math.max(reach, minKm));
      gaps.push({from: pos, reach, next: nxt ? nxt.km : null});
      if (!nxt) break;
      near = [nxt]; left = nxt.km - pos + reserve; onPetrol = true;
    }
    const sweet = pos + 0.55 * (left - reserve);
    const score = c => c.q.pen + c.off * 0.8 + (c.km < sweet ? (sweet - c.km) / 25 : -(c.km - sweet) / 100);
    const best = near.reduce((a, b) => score(b) < score(a) ? b : a);
    const backups = [...near.filter(c => c !== best && c.km > best.km).slice(0, 2), ...near.filter(c => c !== best && c.km < best.km).slice(-1)];
    stops.push({id: best.q.s.id, km: best.km, off: best.off, arrive: left - (best.km - pos), onPetrol,
                backups: backups.map(b => ({id: b.q.s.id, km: b.km, off: b.off, arrive: left - (b.km - pos)}))});
    pos = best.km; left = range;
  }
  return {stops, gaps, arrive: left - (L.total - pos)};
}

async function osrm(points) {
  const c = points.map(p => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(";");
  const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${c}?overview=full&geometries=geojson`);
  if (!r.ok) throw new Error(`Routing service returned ${r.status}. Try again in a few seconds.`);
  const j = await r.json();
  if (j.code !== "Ok") throw new Error(j.code === "NoRoute" ? "No road route between these places." : (j.message || j.code));
  const rt = j.routes[0];
  return {line: rt.geometry.coordinates.map(([lo, la]) => [la, lo]), km: rt.distance / 1000, min: rt.duration / 60, legs: rt.legs.map(l => l.distance / 1000)};
}

let LCACHE = null;
function lineOf(trip) {
  if (!LCACHE || LCACHE.id !== trip.rid) LCACHE = {id: trip.rid, L: prepLine(trip.line)};
  return LCACHE.L;
}

async function buildTrip(start, fill, targets, prev) {
  const rt = await osrm([start, ...targets]);
  const L = prepLine(rt.line);
  const scale = L.total / rt.km;
  let acc = 0;
  const legEnds = rt.legs.map(d => (acc += d * scale));
  const excluded = new Set(prev?.excluded || []);
  const plan = planStops(L, fill, excluded);
  const trip = {
    rid: Math.random().toString(36).slice(2, 8), id: prev?.id || Math.random().toString(36).slice(2, 8),
    created: prev?.created || new Date().toISOString(), line: L.ll.map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]),
    total: L.total, min: rt.min, legEnds, targets, start: {lat: start.lat, lon: start.lon, label: start.label}, fill,
    ...plan, excluded: [...excluded], skipped: prev?.skipped || [], log: prev?.log || [], prompted: {}, active: prev?.active || false,
  };
  LCACHE = {id: trip.rid, L};
  return trip;
}

// ---------- search (Photon) ----------
async function geocode(q) {
  const c = map.getCenter();
  const u = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en&lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&bbox=68,6,97.5,37.5`;
  const r = await fetch(u);
  if (!r.ok) return [];
  const j = await r.json();
  return j.features.map(f => {
    const p = f.properties, sub = [p.street, p.district || p.locality, p.city || p.county, p.state].filter((v, i, a) => v && v !== p.name && a.indexOf(v) === i);
    return {label: p.name || sub[0] || q, sub: sub.join(", "), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0]};
  });
}

function gpsOnce() {
  return new Promise((res, rej) => {
    if (me) return res(me);
    if (!navigator.geolocation) return rej(new Error("This browser can't share your location."));
    navigator.geolocation.getCurrentPosition(p => { setMe(p); res(me); },
      e => rej(new Error(e.code === 1 ? "Location permission is off. Allow it in the browser, or type a start place." : "Couldn't get your location. Type a start place instead.")),
      {enableHighAccuracy: true, timeout: 15000, maximumAge: 60000});
  });
}

async function resolvePlace(p) {
  if (p?.gps) { const m = await gpsOnce(); return {lat: m[0], lon: m[1], label: "My location"}; }
  return p;
}

// ---------- map ----------
const dark = matchMedia("(prefers-color-scheme: dark)").matches;
const map = L.map("map", {zoomControl: false, preferCanvas: true, attributionControl: true}).setView([21.5, 78.9], 5);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
const stLayer = L.layerGroup().addTo(map), tripLayer = L.layerGroup().addTo(map);
let meMarker = null, meRing = null;

function drawStations() {
  stLayer.clearLayers();
  const z = map.getZoom(), r = z < 7 ? 2 : z < 10 ? 3.5 : 5.5;
  for (const t of ["stale", "likely", "active"]) {
    const col = css("--" + t);
    for (const q of Q) if (!q.dead && q.s.tier === t)
      L.circleMarker([q.s.lat, q.s.lon], {radius: r, weight: r > 4 ? 1 : 0, color: css("--card"), fillColor: col, fillOpacity: .85})
        .bindPopup(() => stationPopup(q.s.id), {maxWidth: 280}).addTo(stLayer);
  }
}
map.on("zoomend", drawStations);

const pin = (label, bg, size = 26) => L.divIcon({className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  html: `<div class="pin" style="width:${size}px;height:${size}px;background:${bg}">${label}</div>`});

function drawTrip() {
  tripLayer.clearLayers();
  const t = S.trip;
  if (!t) return;
  L.polyline(t.line, {color: css("--route"), weight: 6, opacity: .9}).addTo(tripLayer);
  L.circleMarker([t.start.lat, t.start.lon], {radius: 7, color: "#fff", weight: 2, fillColor: css("--route"), fillOpacity: 1}).addTo(tripLayer).bindPopup(esc(t.start.label));
  t.targets.forEach((p, i) => {
    const last = i === t.targets.length - 1;
    L.marker([p.lat, p.lon], {icon: pin(last ? "" : i + 1, last ? css("--closed") : "#555", last ? 18 : 22)}).addTo(tripLayer).bindPopup(esc(p.label));
  });
  t.skipped.forEach(s => L.marker([s.lat, s.lon], {icon: pin("✕", css("--closed"), 20)}).addTo(tripLayer).bindPopup(`${esc(s.name)}<br>${esc(EVENTS[s.event])}`));
  t.stops.forEach((st, i) => {
    st.backups.forEach(b => { const q = QID[b.id]; if (q) L.circleMarker([q.s.lat, q.s.lon], {radius: 7, color: "#fff", weight: 2, fillColor: css("--stale"), fillOpacity: 1}).bindPopup(() => stationPopup(b.id), {maxWidth: 280}).addTo(tripLayer); });
    const q = QID[st.id];
    if (q) L.marker([q.s.lat, q.s.lon], {icon: pin("CNG", css("--accent"), 32), zIndexOffset: 500}).bindPopup(() => stationPopup(st.id), {maxWidth: 280}).addTo(tripLayer);
  });
}

function setMe(p) {
  me = [p.coords.latitude, p.coords.longitude];
  if (!meMarker) {
    meRing = L.circle(me, {radius: p.coords.accuracy, color: css("--route"), weight: 0, fillOpacity: .12}).addTo(map);
    meMarker = L.circleMarker(me, {radius: 8, color: "#fff", weight: 3, fillColor: css("--route"), fillOpacity: 1}).addTo(map);
  } else { meMarker.setLatLng(me); meRing.setLatLng(me).setRadius(p.coords.accuracy); }
}

function stationPopup(id) {
  const q = QID[id];
  if (!q) return "Station not found";
  const s = q.s, inTrip = S.trip && (S.trip.stops.some(x => x.id === id) || S.trip.stops.some(x => x.backups.some(b => b.id === id)));
  const hist = q.events.slice(-3).map(e => `${EVENTS[e.event] || e.event} · ${new Date(e.ts).toLocaleDateString("en-IN", {day: "numeric", month: "short"})}`).join("<br>");
  return `<div class="pop"><h3>${esc(s.name)}</h3>
    <div class="muted">${esc([s.op, s.city, s.state].filter(Boolean).join(" · "))}</div>
    <div style="margin-top:6px"><span class="chip"><span class="dot" style="background:${css("--" + s.tier)}"></span>${TIER_LABEL[s.tier]}</span></div>
    <div class="muted" style="margin-top:4px">${esc(s.reason)}</div>
    ${hist ? `<div class="muted" style="margin-top:6px"><b>Your reports</b><br>${hist}</div>` : ""}
    <div class="acts"><a href="${nav(s.lat, s.lon)}" target="_blank" rel="noopener">Navigate</a>
    <button type="button" data-report="${esc(id)}">Report</button>
    ${!inTrip ? `<button type="button" data-addstop="${esc(id)}">Add as stop</button>` : ""}</div></div>`;
}

// ---------- waypoint inputs ----------
function renderWps() {
  const n = S.places.length;
  $("#wps").innerHTML = S.places.map((p, i) => {
    const kind = i === 0 ? "start" : i === n - 1 ? "dest" : "stop";
    const ph = i === 0 ? "Choose start" : i === n - 1 ? "Where to?" : `Stop ${i}`;
    const rm = kind === "stop" ? `<button type="button" class="iconbtn" data-rm="${i}" aria-label="Remove stop ${i}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>` : "<span></span>";
    return `<div class="wp ${kind}"><span class="mk"></span><input id="wp${i}" data-i="${i}" value="${esc(p?.label || "")}" placeholder="${ph}" autocomplete="off" enterkeyhint="search">${rm}</div>`;
  }).join("");
}

let suggTimer = null, suggFor = null, suggItems = [];
function closeSugg() { document.querySelectorAll(".sugg").forEach(e => e.remove()); suggFor = null; }
function showSugg(i, items) {
  closeSugg();
  suggFor = i; suggItems = items;
  if (!items.length) return;
  const box = document.createElement("div");
  box.className = "sugg";
  box.innerHTML = items.map((it, k) => `<button type="button" data-k="${k}">${esc(it.label)}${it.sub ? `<small>${esc(it.sub)}</small>` : ""}</button>`).join("");
  $(`#wp${i}`).parentElement.appendChild(box);
}
function quickItems(i) {
  const q = [{label: "My location", sub: "Use GPS", gps: true}];
  if (S.home) q.push({...S.home, label: "Home", sub: S.home.sub || S.home.label});
  return q;
}
$("#wps").addEventListener("focusin", e => { if (e.target.dataset.i != null) { e.target.select(); showSugg(+e.target.dataset.i, quickItems()); } });
$("#wps").addEventListener("input", e => {
  const i = +e.target.dataset.i, v = e.target.value.trim();
  clearTimeout(suggTimer);
  if (v.length < 3) { showSugg(i, quickItems()); return; }
  suggTimer = setTimeout(async () => { try { const r = await geocode(v); if (suggFor === i || suggFor === null) showSugg(i, r); } catch (err) { toast("Place search is unreachable. Check your connection."); } }, 350);
});
$("#wps").addEventListener("keydown", e => {
  if (e.key === "Enter" && suggItems.length && suggFor != null) { e.preventDefault(); choose(suggFor, suggItems[0]); }
  if (e.key === "Escape") closeSugg();
});
$("#wps").addEventListener("pointerdown", e => { if (e.target.closest(".sugg button")) e.preventDefault(); });
$("#wps").addEventListener("click", e => {
  const b = e.target.closest(".sugg button");
  if (b) return choose(suggFor, suggItems[+b.dataset.k]);
  const rm = e.target.closest("[data-rm]");
  if (rm) { S.places.splice(+rm.dataset.rm, 1); save(); renderWps(); render(); }
});
document.addEventListener("click", e => { if (!e.target.closest(".wp")) closeSugg(); });

function choose(i, it) {
  S.places[i] = it.gps ? {label: "My location", gps: true} : {label: it.label, sub: it.sub, lat: it.lat, lon: it.lon};
  closeSugg(); save(); renderWps();
  if (!it.gps) map.setView([it.lat, it.lon], Math.max(map.getZoom(), 11));
  const empty = S.places.findIndex(p => !p);
  if (empty >= 0) $(`#wp${empty}`)?.focus(); else document.activeElement.blur();
  render();
}
$("#addStop").addEventListener("click", () => { S.places.splice(S.places.length - 1, 0, null); save(); renderWps(); $(`#wp${S.places.length - 2}`).focus(); });
$("#swap").addEventListener("click", () => { S.places.reverse(); save(); renderWps(); render(); });

// ---------- sheet views ----------
function vehicleForm(compact) {
  const v = S.vehicle;
  return `<div class="field"><label for="fill">CNG in tank now</label><output id="fillOut">${v.fill}% · ~${Math.round(v.range * v.fill / 100)} km</output>
      <input type="range" id="fill" min="5" max="100" step="5" value="${v.fill}"></div>
    ${compact ? "" : `<div class="grid2">
      <div class="nf"><label for="range">Full-tank range</label><span><input class="num" id="range" type="number" inputmode="numeric" min="50" max="600" value="${v.range}"> km</span></div>
      <div class="nf"><label for="reserve">Keep in reserve</label><span><input class="num" id="reserve" type="number" inputmode="numeric" min="0" max="150" value="${v.reserve}"> km</span></div>
    </div>`}`;
}

function bindVehicle() {
  const f = $("#fill");
  if (f) f.addEventListener("input", () => { S.vehicle.fill = +f.value; $("#fillOut").textContent = `${f.value}% · ~${Math.round(S.vehicle.range * f.value / 100)} km`; save(); });
  for (const k of ["range", "reserve"]) { const el = $("#" + k); if (el) el.addEventListener("change", () => { const n = +el.value; if (n >= 0) { S.vehicle[k] = n; save(); render(); } }); }
}

function render() {
  const body = $("#body"), t = S.trip;
  $("#sheet").classList.toggle("min", S.sheetMin);
  if (!t) {
    const ready = S.places[0] && S.places[S.places.length - 1] && S.places.every(Boolean);
    body.innerHTML = `
      <div><h2>Plan a CNG drive</h2><div class="muted">${DATA.s.length ? `${Q.filter(q => !q.dead).length.toLocaleString("en-IN")} CNG stations · data ${esc(DATA.asof)}` : "Loading stations…"}</div></div>
      ${vehicleForm(false)}
      <div class="row"><button class="btn primary" id="go" type="button" ${ready ? "" : "disabled"}>Find CNG stops</button>
        <button class="btn" id="nearMe" type="button">CNG near me</button></div>
      <div id="nearList"></div>
      ${dataBlock()}`;
    bindVehicle();
    $("#go").addEventListener("click", plan);
    $("#nearMe").addEventListener("click", nearMe);
    bindData();
    return;
  }
  const next = t.stops[0], nq = next && QID[next.id];
  const L = lineOf(t);
  let prog = null;
  if (me && t.active) { const p = projectPoint(L, me[0], me[1]); if (p.off < 5) prog = p.km; }
  const leftNow = prog != null ? Math.round(S.vehicle.range * t.fill / 100 - prog) : null;
  const items = [
    ...t.stops.map((s, i) => ({kind: "fill", km: s.km, s, i})),
    ...t.targets.map((p, i) => ({kind: i === t.targets.length - 1 ? "dest" : "stop", km: t.legEnds[i], p, i})),
  ].sort((a, b) => a.km - b.km);
  body.innerHTML = `
    <div class="stat"><div><b>${fmtKm(t.total)} km</b><span>to ${esc(t.targets[t.targets.length - 1].label)}</span></div>
      <div><b>${fmtDur(t.min)}</b><span>driving</span></div>
      <div><b>${t.stops.length}</b><span>CNG fill${t.stops.length === 1 ? "" : "s"}</span></div></div>
    ${nq ? `<div class="next"><div class="eyebrow">Next fill${prog != null ? ` · ${fmtKm(Math.max(0, next.km - prog))} km ahead` : ` · km ${fmtKm(next.km)}`}</div>
      <h2>${esc(nq.s.name)}</h2>
      <div class="muted">${esc([nq.s.op, nq.s.city].filter(Boolean).join(" · "))}</div>
      <div class="row"><span class="chip"><span class="dot" style="background:${css("--" + nq.s.tier)}"></span>${TIER_LABEL[nq.s.tier]}</span>
        <span class="muted">arrive with ~${Math.max(0, Math.round(next.arrive))} km left${next.off > 0.3 ? ` · ${fmtKm(next.off)} km off route` : ""}</span></div>
      ${nq.queues ? `<div class="warn">You've reported long queues here ${nq.queues}×.</div>` : ""}
      ${next.onPetrol ? `<div class="warn">No CNG reachable before this on your remaining range. Drive the gap on petrol.</div>` : ""}
      <div class="row"><a class="btn blue" href="${nav(nq.s.lat, nq.s.lon)}" target="_blank" rel="noopener">Navigate</a>
        <button class="btn primary" type="button" data-report="${esc(next.id)}">I'm here</button></div></div>`
      : `<div class="next"><div class="eyebrow">No fill needed</div><div>You reach the destination with ~${Math.max(0, Math.round(t.arrive))} km of CNG left.</div></div>`}
    ${t.gaps.map(g => `<div class="warn">No CNG station on the route between km ${fmtKm(g.from)} and ${fmtKm(g.reach)}${g.next ? `. The next one is at km ${fmtKm(g.next)}` : ""}. Fill up fully before, and keep petrol for this stretch.</div>`).join("")}
    ${leftNow != null ? `<div class="muted">Estimated CNG left now: ~${Math.max(0, leftNow)} km (${fmtKm(prog)} km driven on this leg)</div>` : ""}
    <ol class="tl">
      <li><span class="m" style="background:${css("--route")}"></span><div><div class="t">${esc(t.start.label)}</div><div class="s">Start · ${t.fill}% CNG</div></div></li>
      ${items.map(it => it.kind === "fill" ? fillItem(it.s, it.i) :
        `<li><span class="m" style="background:${it.kind === "dest" ? css("--closed") : "#666"}"></span><div><div class="t">${esc(it.p.label)}</div><div class="s">${it.kind === "dest" ? "Destination" : "Your stop"} · km ${fmtKm(it.km)}</div></div></li>`).join("")}
    </ol>
    <div class="row">
      ${!t.active ? `<button class="btn primary" id="startTrip" type="button">Start guidance</button>` : ""}
      <a class="btn" href="${fullRouteLink(t)}" target="_blank" rel="noopener">Whole route in Google Maps</a>
      <button class="btn" id="replan" type="button">Replan from here</button>
      <button class="btn" id="endTrip" type="button">End trip</button>
    </div>
    ${t.active ? `<div class="muted">Guidance is on: keep this page open. When you reach a fill stop it will ask if you filled.</div>` : ""}`;
  $("#startTrip")?.addEventListener("click", startGuidance);
  $("#endTrip").addEventListener("click", endTrip);
  $("#replan").addEventListener("click", replanHere);
}

function fillItem(st, i) {
  const q = QID[st.id];
  if (!q) return "";
  const bks = st.backups.map(b => QID[b.id] && `<div><b>${esc(QID[b.id].s.name)}</b> <span class="muted">km ${fmtKm(b.km)} · ${TIER_LABEL[QID[b.id].s.tier]}</span>
      <div class="acts"><a href="${nav(QID[b.id].s.lat, QID[b.id].s.lon)}" target="_blank" rel="noopener">Navigate</a><button type="button" data-report="${esc(b.id)}">I'm here</button></div></div>`).filter(Boolean).join("");
  return `<li><span class="m" style="background:${css("--accent")}"></span><div>
    <div class="t">${i === 0 ? "Fill " : "Fill "}${i + 1}: ${esc(q.s.name)}</div>
    <div class="s">km ${fmtKm(st.km)} · ${TIER_LABEL[q.s.tier]} · arrive with ~${Math.max(0, Math.round(st.arrive))} km</div>
    <div class="acts"><a href="${nav(q.s.lat, q.s.lon)}" target="_blank" rel="noopener">Navigate</a><button type="button" data-report="${esc(st.id)}">I'm here</button></div>
    ${bks ? `<details><summary>${st.backups.length} backup${st.backups.length > 1 ? "s" : ""} nearby</summary><div class="bk">${bks}</div></details>` : ""}
  </div></li>`;
}

function fullRouteLink(t) {
  const pts = [...t.stops.map(s => ({km: s.km, ll: [QID[s.id]?.s.lat, QID[s.id]?.s.lon]})), ...t.targets.slice(0, -1).map((p, i) => ({km: t.legEnds[i], ll: [p.lat, p.lon]}))]
    .filter(p => p.ll[0] != null).sort((a, b) => a.km - b.km).slice(0, 9).map(p => p.ll.join(","));
  const d = t.targets[t.targets.length - 1];
  return `https://www.google.com/maps/dir/?api=1&origin=${t.start.lat},${t.start.lon}&destination=${d.lat},${d.lon}&travelmode=driving${pts.length ? "&waypoints=" + encodeURIComponent(pts.join("|")) : ""}`;
}

function dataBlock() {
  const mine = FB.length;
  return `<details><summary>Your reports and settings</summary><div class="bk">
    <div class="muted">${mine} report${mine === 1 ? "" : "s"} saved on this phone. Export them to add to the main dataset.</div>
    <div class="row"><button class="btn" id="exportFb" type="button">Copy reports</button>
    <label class="btn" for="importFb">Import file</label><input id="importFb" type="file" accept=".json,.jsonl,application/json" hidden>
    <button class="btn" id="setHome" type="button" ${S.places[0] && !S.places[0].gps ? "" : "disabled"}>Save start as Home</button></div>
    ${S.home ? `<div class="muted">Home: ${esc(S.home.label)}</div>` : ""}
  </div></details>`;
}

function bindData() {
  $("#exportFb")?.addEventListener("click", async () => {
    const txt = JSON.stringify({app: "cng-route", exported: new Date().toISOString(), feedback: FB});
    try { await navigator.clipboard.writeText(txt); toast("Reports copied. Paste them to Claude or into a file."); }
    catch (e) {
      const blob = new Blob([txt], {type: "application/json"}), a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `cng-reports-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    }
  });
  $("#importFb")?.addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const txt = await f.text();
      const rows = txt.trim().startsWith("{") && txt.includes('"feedback"') ? JSON.parse(txt).feedback : txt.split(/\n+/).filter(Boolean).map(l => JSON.parse(l));
      const seen = new Set(FB.map(x => x.ts + x.station_id));
      rows.forEach(r => { if (r.station_id && !seen.has(r.ts + r.station_id)) FB.push(r); });
      LS.set("feedback", FB); quality(); drawStations(); render(); toast(`Imported ${rows.length} reports.`);
    } catch (err) { toast("That file isn't a reports export."); }
  });
  $("#setHome")?.addEventListener("click", () => { S.home = {...S.places[0]}; save(); render(); toast("Home saved."); });
}

// ---------- actions ----------
async function plan() {
  const btn = $("#go");
  btn.disabled = true; btn.innerHTML = `<span class="spin"></span> Planning`;
  try {
    const pts = await Promise.all(S.places.map(resolvePlace));
    S.trip = await buildTrip(pts[0], S.vehicle.fill, pts.slice(1), null);
    save(); drawTrip(); fitTrip(); render();
  } catch (e) { toast(e.message); render(); }
}

function fitTrip() { if (S.trip) map.fitBounds(L.latLngBounds(S.trip.line), {paddingTopLeft: [20, innerWidth >= 900 ? 20 : 170], paddingBottomRight: [20, innerWidth >= 900 ? 20 : innerHeight * 0.5], ...(innerWidth >= 900 ? {paddingTopLeft: [430, 20]} : {})}); }

async function nearMe() {
  const box = $("#nearList");
  box.innerHTML = `<span class="spin"></span>`;
  try {
    const m = await gpsOnce();
    const list = Q.filter(q => !q.dead).map(q => ({q, d: hav(m, [q.s.lat, q.s.lon])})).sort((a, b) => a.d - b.d + (a.q.pen - b.q.pen) * 0.3).slice(0, 8);
    box.innerHTML = `<ol class="tl">${list.map(({q, d}) => `<li><span class="m" style="background:${css("--" + q.s.tier)}"></span><div><div class="t">${esc(q.s.name)}</div>
      <div class="s">${fmtKm(d)} km away · ${TIER_LABEL[q.s.tier]}${q.queues ? ` · queues reported ${q.queues}×` : ""}</div>
      <div class="acts"><a href="${nav(q.s.lat, q.s.lon)}" target="_blank" rel="noopener">Navigate</a><button type="button" data-report="${esc(q.s.id)}">Report</button></div></div></li>`).join("")}</ol>`;
    map.setView(m, 12);
  } catch (e) { box.innerHTML = `<div class="warn">${esc(e.message)}</div>`; }
}

function startGuidance() {
  S.trip.active = true; save();
  if (navigator.geolocation && watchId == null)
    watchId = navigator.geolocation.watchPosition(onPos, () => toast("Location is off, so guidance can't track you. Tap “I'm here” at each stop instead."), {enableHighAccuracy: true, maximumAge: 10000});
  try { navigator.wakeLock?.request("screen").catch(() => {}); } catch (e) {}
  render();
  toast("Guidance on. Navigate to the next fill; I'll ask when you get there.");
}

let lastRender = 0;
function onPos(p) {
  setMe(p);
  const t = S.trip;
  if (!t || !t.active) return;
  for (const st of t.stops.slice(0, 1).flatMap(s => [s, ...s.backups])) {
    const q = QID[st.id];
    if (q && !t.prompted[st.id] && hav(me, [q.s.lat, q.s.lon]) < 0.3) { t.prompted[st.id] = true; save(); openReport(st.id, true); break; }
  }
  if (Date.now() - lastRender > 15000 && !document.querySelector(".scrim")) { lastRender = Date.now(); render(); }
}

async function replanHere() {
  try {
    const m = await gpsOnce();
    openFillAsk(async fill => {
      const t = S.trip, L = lineOf(t), here = projectPoint(L, m[0], m[1]);
      const targets = t.targets.filter((p, i) => t.legEnds[i] > here.km + 0.5);
      S.trip = await buildTrip({lat: m[0], lon: m[1], label: "My location"}, fill, targets.length ? targets : t.targets.slice(-1), t);
      save(); drawTrip(); render(); toast("Replanned from your location.");
    });
  } catch (e) { toast(e.message); }
}

function endTrip() {
  const past = LS.get("trips", []); past.push({...S.trip, line: undefined}); LS.set("trips", past.slice(-20));
  S.trip = null; save();
  if (watchId != null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  drawTrip(); render();
}

// ---------- report dialog ----------
function openReport(id, auto) {
  const q = QID[id];
  if (!q) return;
  closeDialog();
  const d = document.createElement("div");
  d.className = "scrim";
  d.innerHTML = `<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="dlgT">
    <div><div class="muted">${auto ? "You've reached" : "Report for"}</div><h2 id="dlgT">${esc(q.s.name)}</h2></div>
    <div style="font-weight:600">Did you fill CNG here?</div>
    <div class="opts">
      <button class="opt good" type="button" data-ev="filled">Yes, filled<small>I'll plan the next stop from here</small></button>
      <button class="opt" type="button" data-ev="long_queue">Long queue<small>Skipped it, send me on</small></button>
      <button class="opt bad" type="button" data-ev="no_gas">No gas<small>Low pressure or dispenser down</small></button>
      <button class="opt bad" type="button" data-ev="closed_temp">Closed today<small>Shut, maintenance</small></button>
      <button class="opt bad" type="button" data-ev="closed_permanent">Closed for good<small>Never route here again</small></button>
      <button class="opt bad" type="button" data-ev="not_found">Couldn't find it<small>Wrong location or no CNG</small></button>
    </div>
    <div id="extra"></div>
    <button class="btn" type="button" id="dlgClose">Not now</button>
  </div>`;
  document.body.appendChild(d);
  d.addEventListener("click", e => { if (e.target === d) closeDialog(); });
  $("#dlgClose").addEventListener("click", closeDialog);
  d.querySelectorAll("[data-ev]").forEach(b => b.addEventListener("click", () => {
    const ev = b.dataset.ev, ex = $("#extra");
    if (ev === "filled") {
      ex.innerHTML = `<div class="field"><label for="after">Filled up to</label><output id="afterOut">100%</output><input type="range" id="after" min="30" max="100" step="5" value="100"></div>
        <button class="btn primary" type="button" id="ok">Save and continue</button>`;
      $("#after").addEventListener("input", e => $("#afterOut").textContent = e.target.value + "%");
      $("#ok").addEventListener("click", () => submit(id, ev, {fill: +$("#after").value}));
    } else if (ev === "long_queue") {
      ex.innerHTML = `<div class="field"><label for="wait">Estimated wait</label><output id="waitOut">30 min</output><input type="range" id="wait" min="10" max="120" step="5" value="30"></div>
        <button class="btn primary" type="button" id="ok">Skip it and reroute</button>`;
      $("#wait").addEventListener("input", e => $("#waitOut").textContent = e.target.value + " min");
      $("#ok").addEventListener("click", () => submit(id, ev, {wait: +$("#wait").value}));
    } else submit(id, ev, {});
  }));
}
function closeDialog() { document.querySelector(".scrim")?.remove(); }

function openFillAsk(cb) {
  closeDialog();
  const d = document.createElement("div");
  d.className = "scrim";
  d.innerHTML = `<div class="dlg" role="dialog" aria-modal="true"><h2>How much CNG is left?</h2>
    <div class="field"><label for="nowFill">Tank now</label><output id="nowOut">50%</output><input type="range" id="nowFill" min="5" max="100" step="5" value="50"></div>
    <div class="row"><button class="btn primary" type="button" id="ok">Replan</button><button class="btn" type="button" id="cx">Cancel</button></div></div>`;
  document.body.appendChild(d);
  $("#nowFill").addEventListener("input", e => $("#nowOut").textContent = e.target.value + "%");
  $("#cx").addEventListener("click", closeDialog);
  $("#ok").addEventListener("click", () => { const v = +$("#nowFill").value; closeDialog(); cb(v); });
}

async function submit(id, event, opts) {
  const q = QID[id];
  const e = {ts: new Date().toISOString(), station_id: id, event, station_name: q.s.name, lat: q.s.lat, lon: q.s.lon, source: "phone"};
  if (opts.wait) e.wait_min = opts.wait;
  if (opts.fill) e.fill_after = opts.fill;
  FB.push(e); LS.set("feedback", FB); quality(); drawStations();
  closeDialog();
  const t = S.trip;
  if (!t) { toast(`Saved: ${EVENTS[event]}.`); render(); return; }
  t.log.push(e);
  const L = lineOf(t), here = projectPoint(L, q.s.lat, q.s.lon);
  const planned = t.stops.find(s => s.id === id) || t.stops.flatMap(s => s.backups).find(b => b.id === id);
  let fill;
  if (event === "filled") fill = opts.fill || 100;
  else {
    const est = planned ? planned.arrive : S.vehicle.range * t.fill / 100 - here.km;
    fill = Math.max(5, Math.min(100, Math.round(100 * est / S.vehicle.range)));
    t.excluded.push(id); t.skipped.push({id, name: q.s.name, lat: q.s.lat, lon: q.s.lon, event});
  }
  const targets = t.targets.filter((p, i) => t.legEnds[i] > here.km + 0.5);
  toast("Saved. Rerouting…");
  try {
    S.trip = await buildTrip({lat: q.s.lat, lon: q.s.lon, label: q.s.name}, fill, targets.length ? targets : t.targets.slice(-1), t);
    save(); drawTrip(); render();
    const n = S.trip.stops[0];
    toast(n ? `Next fill: ${QID[n.id].s.name}, ${fmtKm(n.km)} km ahead.` : "No more fills needed to reach your destination.");
  } catch (err) { toast(err.message); save(); render(); }
}

document.addEventListener("click", e => {
  const r = e.target.closest("[data-report]");
  if (r) { map.closePopup(); openReport(r.dataset.report, false); return; }
  const a = e.target.closest("[data-addstop]");
  if (a) {
    const q = QID[a.dataset.addstop]; map.closePopup();
    S.places.splice(S.places.length - 1, 0, {label: q.s.name, lat: q.s.lat, lon: q.s.lon}); save(); renderWps(); render();
    toast("Added as a stop. Tap “Find CNG stops” to plan.");
  }
});

$("#handle").addEventListener("click", () => { S.sheetMin = !S.sheetMin; save(); render(); });
$("#locate").addEventListener("click", async () => { try { const m = await gpsOnce(); map.setView(m, 13); } catch (e) { toast(e.message); } });

let toastTimer;
function toast(msg) {
  document.querySelector(".toast")?.remove();
  const t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
  document.body.appendChild(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 4500);
}

// ---------- boot ----------
renderWps(); render();
fetch("stations.json").then(r => r.json()).then(d => {
  DATA = d; quality(); drawStations(); render();
  if (S.trip) { drawTrip(); fitTrip(); if (S.trip.active) startGuidance(); }
}).catch(() => toast("Couldn't load the station list. Check your connection and reload."));
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
