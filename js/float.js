// Floating engine. One implementation of move / resize / clamp / raise / persist, used by two kinds of thing:
//   popups   Settings (#ad), the word-log drawer (#hist) and the gameplay dialogue (#dlg). Always movable and remembered per device.
//            The dialogue is also always resizable (width only), with or without Floating Workspace.
//   modules  Board, player panels, Turn Controls, Game Tools and word log: movable AND resizable (panels and control modules on BOTH axes), but only while "Floating Workspace" is ON.
//            Game Tools is the second half of the old button rack: while ON its buttons live in #tools (a separate module), and leaving restores one group.
// Architecture: the default layout is stable CSS (not adjustable from Settings); Floating Workspace is the optional direct-manipulation
// layer (it sets <html data-floating="true"> plus inline left/top/size); messages (toast, dialogue) float in every mode, independent of it.
// Turning the workspace off removes the attribute, handles and inline geometry, so the normal CSS layout is back at once.
// Precedence while ON:  saved override for this orientation  >  default derived from the viewport, the layout preference and the rendered modules.
// Storage: scrabble.float (popup positions, unchanged format) and scrabble.floatWorkspace.v2 (on/off + per-orientation geometry). Every saved module
// also remembers the area (aw, ah) and its own height (bh) it was saved in, so a different viewport maps the layout proportionally (see applyGeom).
// Pure UI: no game state is read or written here.
import { nameOf, onNamesChange } from './names.js';

const LEGACY = 'scrabble.float', WSKEY = 'scrabble.floatWorkspace.v2', M = 8;
const ORI = ['portrait', 'landscape'];
const html = () => document.documentElement;
const read = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// ---------- persisted state ----------
let saved = read(LEGACY) || {};                                  // popups: { id: [x, y] } (the dialogue adds a third value: its chosen width)
const ws = { enabled: false, tools: 'auto', portrait: {}, landscape: {} };      // workspace: per orientation { id: {x, y, s | w, h?} }; tools: 'auto' | 'open' | 'min' (Game Tools state)
{
  const s = read(WSKEY);
  if (s && s.v === 2) {
    ws.enabled = s.enabled === true;
    if (s.tools === 'open' || s.tools === 'min') ws.tools = s.tools;   // only an explicit user choice is stored; 'auto' follows the screen
    for (const o of ORI) for (const [id, g] of Object.entries(s[o] || {}))
      if (g && typeof g === 'object' && Object.values(g).every(Number.isFinite)) ws[o][id] = g;
  }
}
const saveWS = () => write(WSKEY, { v: 2, enabled: ws.enabled, ...(ws.tools !== 'auto' && { tools: ws.tools }), portrait: ws.portrait, landscape: ws.landscape });

// Game Tools can be minimized to a single small button. Until the user chooses, the state follows the screen: compact screens (shortest side under COMPACT CSS px, so
// phones in either orientation and small windows) start minimized; larger ones start expanded. An explicit choice is kept. Each state keeps its own saved geometry
// ('tools' = expanded, 'toolsMin' = the button), so neither overwrites the other.
const COMPACT = 600;
const toolsMin = () => ws.tools === 'min' || (ws.tools !== 'open' && Math.min(innerWidth, innerHeight) < COMPACT);
const gid = t => t.id === 'tools' && toolsMin() ? 'toolsMin' : t.id;
const savePopups = () => write(LEGACY, saved);

// ---------- viewport: safe-area aware, never relies on 100vh ----------
let probe;
function area() {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.append(probe);
  }
  const c = getComputedStyle(probe), p = k => parseFloat(c[k]) || 0;
  const a = { x0: p('paddingLeft') + M, y0: p('paddingTop') + M, x1: innerWidth - p('paddingRight') - M, y1: innerHeight - p('paddingBottom') - M };
  a.w = Math.max(0, a.x1 - a.x0); a.h = Math.max(0, a.y1 - a.y0);
  return a;
}
const orient = () => innerWidth > innerHeight ? 'landscape' : 'portrait';
// Popups are kept inside the screen. Workspace modules (loose = true) may be ANY size: one that fits stays fully inside, one that is larger than the screen can be panned
// so that every edge, and with it every handle, can be brought into view (the pan range flips: [right edge flush .. left edge flush]). e = room for hanging chrome.
const fit = (x, y, w, h, loose = false, e = 0) => {
  const a = area();
  if (!loose) return [clamp(x, a.x0, a.x1 - w), clamp(y, a.y0, a.y1 - h)];
  const rx = [a.x1 - w - e, a.x0], ry = [a.y1 - h - e, a.y0];
  return [clamp(x, Math.min(...rx), Math.max(...rx)), clamp(y, Math.min(...ry), Math.max(...ry))];
};

// ---------- module table ----------
// axes: 's' = square (board, 1:1), 'x' = width only, 'xy' = both.
// flex: an 'xy' module whose height is OPTIONAL. Until the player drags vertically its height follows the content (exactly as before); once a height is set (pinned) the
// content adapts to the box: a rack re-flows into rows of square tiles, buttons re-flow into the roomiest grid (see fitContent). Double-click on a handle un-pins it.
const DEFS = {
  board: { sel: '.boardWrap', axes: 's', label: 'اللوح' },
  p0: { sel: '#pn0', axes: 'xy', flex: true, get label() { return nameOf(0); } },   // the players' labels follow their names (see relabel)
  p1: { sel: '#pn1', axes: 'xy', flex: true, get label() { return nameOf(1); } },
  ctrls: { sel: '.ctrls', axes: 'xy', flex: true, label: 'أزرار الدور' },          // Turn Controls
  tools: { sel: '#tools', axes: 'xy', flex: true, label: 'أدوات اللعبة' },        // Game Tools
  hist: { axes: 'xy', label: 'سجل الكلمات' },
  dlg: { axes: 'x', label: 'النافذة', popup: true }   // popup geometry [x, y, w] in scrabble.float; resizable in every mode
};
const things = {};   // id -> { id, el, def, isPopup, canMove(), canResize(), place() }
// z-index bands (bounded and deterministic, never an ever-growing counter). STRICT HIERARCHY, lowest to highest:
//   Board 10  <  player panels 20-2x (+ the docked word log)  <  Turn Controls 30  <  Game Tools 32  <  popups 40+ (settings, open word-log drawer)  <  dialogue 50
//   <  native modal dialogs (top layer)  <  PWA notices.
// THE BOARD IS THE BASE LAYER OF THE FLOATING WORKSPACE, and the two control modules sit on fixed rungs above it: interacting with any module (click, drag, resize,
// tile placement) re-ranks only the player panels among themselves, so the board can never be lifted over a control and a control can never be buried by a rack.
const BASE = { board: 10, mod: 20, turn: 30, tools: 32, pop: 40, dlg: 50 }, order = { mod: [], pop: [], dlg: [] };
const FIXED = { ctrls: BASE.turn, tools: BASE.tools };   // modules that never change rung
const inWs = t => ws.enabled && !!t.def && !t.def.popup;
// The word log is a foreground module while docked, but an on-demand overlay in drawer mode: then it belongs with the popups.
const bandOf = t => t.id === 'dlg' ? 'dlg' : t.id === 'hist' && html().dataset.hist === 'drawer' ? 'pop' : inWs(t) ? 'mod' : 'pop';
export function raise(t) {
  if (typeof t === 'string') t = things[t];
  if (!t) return;
  if (t.id === 'board') { if (inWs(t)) t.el.style.zIndex = BASE.board; return; }   // never promoted: see above
  if (FIXED[t.id]) { if (inWs(t)) t.el.style.zIndex = FIXED[t.id]; return; }
  for (const b of Object.values(order)) { const i = b.indexOf(t); if (i >= 0) b.splice(i, 1); }
  const k = bandOf(t); order[k].push(t);
  order[k].forEach((x, i) => { x.el.style.zIndex = BASE[k] + i; });   // ranks inside a band: bounded, never an ever-growing counter
}

// FLOATING WORKSPACE HAS NO MAXIMUM SIZE. Every module can be made as large as the player wants (HUGE only guards the browser's own layout limits); the sole floor is a size
// at which the module is still a visible, grabbable thing. Content scales with the module (see setUnit and css/float.css), so any size stays proportionate.
// The gameplay dialogue is a popup in every mode, not a workspace module, and keeps its original range.
const HUGE = 20000, GRIP_EDGE = 3;   // GRIP_EDGE: the board's grip glyph reaches 3px past the area margin when the board is flush with the corner
function limits(t) {
  const a = area(), id = t.id;
  if (id === 'board') {
    const b = t.el.querySelector('.board'), extra = Math.max(0, t.el.offsetHeight - (b ? b.offsetHeight : 0));
    return { minW: 64, maxW: HUGE, extra };
  }
  if (id === 'hist') return { minW: 140, maxW: HUGE, minH: 90, maxH: HUGE };
  if (id === 'ctrls') return { minW: 72, maxW: HUGE, minH: 64, maxH: HUGE };
  if (id === 'tools') return { minW: 56, maxW: HUGE, minH: 64, maxH: HUGE };
  if (id === 'dlg') return { minW: 260, maxW: Math.min(a.w, 560) };
  return { minW: 96, maxW: HUGE, minH: 72, maxH: HUGE };   // player panels
}
// Proportional content: each module publishes --fu (its "float unit") from its own width; css/float.css multiplies type, padding, gaps and buttons by it.
// 1 = the original sizes. Above the reference width everything grows in step with the module; below the floor width everything shrinks in step, in between nothing
// changes, so a layout the player never touches looks exactly as before.
const UNIT = { p0: [160, 400], p1: [160, 400], ctrls: [100, 360], tools: [100, 360] };
function setUnit(t, w) {
  const u = UNIT[t.id]; if (!u || !inWs(t)) return;
  t.el.style.setProperty('--fu', (w < u[0] ? w / u[0] : w < u[1] ? 1 : w / u[1]).toFixed(3));
}

// ---------- applying geometry ----------
function setSize(t, w, h) {
  const L = limits(t), el = t.el;
  if (t.def.axes === 's') { el.style.setProperty('--float-board-size', clamp(w, L.minW, L.maxW) + 'px'); return; }
  const cw = clamp(w, L.minW, L.maxW); el.style.width = cw + 'px'; setUnit(t, cw);
  if (t.def.axes === 'xy' && h != null) el.style.height = clamp(h, L.minH, L.maxH) + 'px';
  fitContent(t);
}
function setPos(t, x, y) {
  const r = t.el.getBoundingClientRect(), [px, py] = fit(x, y, r.width, r.height, inWs(t), t.id === 'board' ? GRIP_EDGE : 0);
  t.el.style.left = px + 'px'; t.el.style.top = py + 'px';
}
function geomOf(t) {   // what is on screen right now, in storable form (+ the area it was measured in, so another viewport can map it proportionally)
  const r = t.el.getBoundingClientRect(), a = area(), g = { x: r.left, y: r.top };
  if (t.def.axes === 's') g.s = r.width; else g.w = r.width;
  if (t.def.axes === 'xy' && (!t.def.flex || t.el.style.height)) g.h = r.height;   // a flex module stores a height only if the player pinned one
  g.bh = r.height; g.aw = a.w; g.ah = a.h;
  return g;
}
// Restore a saved geometry. Same area: exactly as saved. Different area (window resized, other screen, rotated back): the layout is mapped, not re-defaulted and not
// merely clamped: sizes scale uniformly by the limiting axis, and positions keep their share of the free space (a module that was flush right stays flush right,
// a centred one stays centred), then everything is clamped to this viewport's limits. The saved values themselves are never rewritten by a mere viewport change.
function applyGeom(t, g) {
  const a = area(), mapped = g.aw > 0 && g.ah > 0 && (Math.abs(a.w - g.aw) > 1 || Math.abs(a.h - g.ah) > 1);
  const k = mapped ? Math.min(a.w / g.aw, a.h / g.ah) : 1;
  if ((g.s != null || g.w != null) && !(t.id === 'tools' && toolsMin())) {   // the minimized button has a fixed footprint
    let sz = (g.s ?? g.w) * k;
    // A record without the area it was saved in (older format) cannot be mapped, so it is shown within this screen; records that carry their area keep their proportions at any size.
    if (!(g.aw > 0 && g.ah > 0)) sz = Math.min(sz, t.def.axes === 's' ? Math.min(a.w, a.h - limits(t).extra) : a.w);
    if (t.def.flex && g.h == null) t.el.style.removeProperty('height');   // no stored height: the content decides again
    setSize(t, sz, g.h != null ? g.h * k : undefined);
  }
  if (!mapped) return setPos(t, g.x, g.y);
  const r = t.el.getBoundingClientRect(), w0 = g.s ?? g.w ?? r.width;
  const fx = clamp((g.x - a.x0) / Math.max(1, g.aw - w0), 0, 1), fy = clamp((g.y - a.y0) / Math.max(1, g.ah - (g.bh ?? r.height)), 0, 1);
  setPos(t, a.x0 + fx * Math.max(0, a.w - r.width), a.y0 + fy * Math.max(0, a.h - r.height));
}

// ---------- default geometry: from the live viewport, the Classic/Duel preferences and the rendered modules ----------
function defaults(o) {
  const a = area(), d = html().dataset, T = things, g = {};
  const left = d.swap === 'true' ? 'p1' : 'p0', right = left === 'p0' ? 'p1' : 'p0';
  const histOn = d.hist === 'docked' && !T.hist.el.classList.contains('history-hidden');
  const dock = d.pdock || 'bottom';
  const anchor = (h, top, bot) => dock === 'top' ? top : dock === 'middle' ? top + (bot - top - h) / 2 : bot - h;
  const measure = (t, w) => { clearFit(t); t.el.style.removeProperty('height'); t.el.style.width = w + 'px'; return t.el.offsetHeight; };   // natural height: every module is re-applied right after
  setSize(T.board, Math.min(a.w, a.h) - 80);   // measure the board's chrome (padding + bag) near its final size, not at the CSS default width
  const bl = limits(T.board), extra = bl.extra, dMin = Math.min(240, Math.min(a.w, a.h - extra));   // the default board never starts smaller than 240px unless the screen forces it
  // Minimized Game Tools: same slot, but the layout is computed with the button's real footprint and filed under its own key.
  const fin = () => { if (toolsMin() && g.tools) { g.toolsMin = { x: g.tools.x, y: g.tools.y }; delete g.tools; } return g; };
  if (o === 'landscape') {
    // board centred and as tall as the screen allows; player panels hug it on both sides; controls under the right panel
    const s = clamp(Math.min(a.h - extra - GRIP_EDGE, a.w - 2 * 176 - 2 * M), dMin, HUGE);
    // A panel is sized from the board: seven rack tiles about one board cell wide (+ padding). Small boards keep the 300px floor of the original layout.
    const pMax = limits(T.p0).maxW, pCap = Math.min(pMax, Math.max(300, Math.round(0.58 * s + 24)));
    const colW = clamp((a.w - s) / 2 - M, 168, pCap), pw = clamp(colW, 160, pCap);
    if (a.w - s > Math.min(Math.round(0.32 * s), 360) + pCap + 4 * M + 80) {
      // Wide profile (shape decides, not a resolution): the free width beside the board holds a controls column plus a panel column, so the row becomes Board | Controls | Players.
      // (It used to ask for two whole panel columns, one each side; with the board now exactly the board, with no frame around it, that test flipped on ultrawide screens that had always been wide.)
      const cw = clamp(Math.round(0.32 * s), 168, Math.min(limits(T.ctrls).maxW, 360)), hp = measure(T[left], pw), hq = measure(T[right], pw), hc = measure(T.ctrls, cw), ht = measure(T.tools, cw);
      const total = s + M + cw + M + pw, x0 = Math.max(a.x0, a.x0 + (a.w - total) / 2), bh = s + extra, stackH = hp + M + hq;
      const yP = clamp(a.y0 + (bh - stackH) / 2, a.y0, Math.max(a.y0, a.y1 - stackH));
      g.board = { x: x0, y: a.y0, s };
      const yC = clamp(a.y0 + (bh - (hc + M + ht)) / 2, a.y0, Math.max(a.y0, a.y1 - hc - M - ht));   // Turn Controls over Game Tools, centred on the board
      g.ctrls = { x: x0 + s + M, y: yC, w: cw }; g.tools = { x: x0 + s + M, y: yC + hc + M, w: cw };
      g[left] = { x: x0 + s + M + cw + M, y: yP, w: pw }; g[right] = { x: x0 + s + M + cw + M, y: yP + hp + M, w: pw };
      const below = yP + stackH + M, room = a.y1 - below, wid = clamp(pw, 200, Math.min(limits(T.hist).maxW, a.w));
      g.hist = room >= 160 ? { x: g[left].x, y: below, w: wid, h: clamp(Math.min(room, 560), 160, a.h) }
        : { x: Math.max(a.x0, g[left].x), y: a.y0, w: wid, h: clamp(Math.min(a.h, 560), 160, a.h) };
      return fin();
    }
    const bx = a.x0 + (a.w - s) / 2, lx = Math.max(a.x0, bx - M - pw), rx = Math.min(a.x1 - pw, bx + s + M);
    // each side column is a player panel plus one control module: Turn Controls under the right panel, Game Tools under the left one
    const hp = measure(T[left], pw); measure(T[right], pw); const hc = measure(T.ctrls, pw), ht = measure(T.tools, pw);
    const yR = anchor(hp + M + hc, a.y0, a.y1), yL = anchor(hp + M + ht, a.y0, a.y1);
    g.board = { x: bx, y: a.y0, s };
    g[right] = { x: rx, y: yR, w: pw }; g[left] = { x: lx, y: yL, w: pw };
    g.ctrls = { x: rx, y: yR + hp + M, w: pw }; g.tools = { x: lx, y: yL + hp + M, w: pw };
    const wid = clamp(colW, 200, Math.min(560, a.w)), below = yL + hp + M + ht + M, room = a.y1 - below;
    g.hist = room >= 160 ? { x: Math.max(a.x0, lx + pw - wid), y: below, w: wid, h: clamp(Math.min(room, 560), 160, a.h) }
      : { x: Math.max(a.x0, lx), y: a.y0, w: wid, h: clamp(Math.min(a.h, 560), 160, a.h) };
  } else {
    // board on top at full width, the two panels side by side under it, controls under them
    const pw = Math.floor((a.w - M) / 2);
    // controls: Turn Controls and Game Tools share one row (about 3:2) while it is wide enough, else they stack; Turn Controls start on the reading side
    const rtl = getComputedStyle(document.body).direction === 'rtl', row = a.w >= 300;
    const mw = toolsMin() ? T.tools.el.offsetWidth : 0;   // minimized: Turn Controls take the row, the tools button sits at its end
    const tw = row ? (mw ? a.w - M - mw : Math.round((a.w - M) * 0.58)) : a.w, uw = mw || (row ? a.w - M - tw : a.w);
    const hp = measure(T[left], pw); measure(T[right], pw); const hc = measure(T.ctrls, tw), ht = measure(T.tools, uw);
    const rowH = row ? Math.max(hc, ht) : hc + M + ht;
    const s = clamp(Math.min(a.w - GRIP_EDGE, a.h - extra - M - hp - M - rowH - (histOn ? 150 + M : 0)), dMin, HUGE);
    const yP = a.y0 + s + extra + M, yC = yP + hp + M, below = yC + rowH + M;
    g.board = { x: a.x0 + (a.w - s) / 2, y: a.y0, s };
    g[left] = { x: a.x0, y: yP, w: pw }; g[right] = { x: a.x1 - pw, y: yP, w: pw };
    if (row) { g.ctrls = { x: rtl ? a.x1 - tw : a.x0, y: yC, w: tw }; g.tools = { x: rtl ? a.x0 : a.x1 - uw, y: yC, w: uw }; }
    else { g.ctrls = { x: a.x0, y: yC, w: a.w }; g.tools = { x: a.x0, y: yC + hc + M, w: a.w }; }
    const wid = clamp(Math.min(a.w, 380), 200, a.w);
    g.hist = histOn && a.y1 - below >= 150 ? { x: a.x0, y: below, w: a.w, h: Math.min(a.y1 - below, 560) }
      : { x: a.x0 + (a.w - wid) / 2, y: a.y0, w: wid, h: clamp(Math.min(a.h, 560, 0.7 * innerHeight), 160, a.h) };
  }
  return fin();
}

export function refreshWorkspace() {
  if (!ws.enabled || !things.board) return;
  const o = orient(), mods = Object.values(things).filter(t => t.def && !t.def.popup);
  syncTools();
  const D = mods.some(t => !ws[o][gid(t)]) ? defaults(o) : null;   // overrides are only clamped for display, never rewritten
  for (const t of mods) applyGeom(t, ws[o][gid(t)] || D[gid(t)]);
  const bt = things.board, a = area(), over = bt.el.getBoundingClientRect().bottom - a.y1;   // display-only guard: wrapper chrome can differ by a few px from the estimate
  if (over > 0.5 && !ws[o].board) { const w = bt.el.getBoundingClientRect().width; setSize(bt, w - over); setPos(bt, parseFloat(bt.el.style.left) || a.x0, parseFloat(bt.el.style.top) || a.y0); }
  for (const t of mods) fitContent(t);
}
function reflowPopups() {
  for (const t of Object.values(things)) if (t.isPopup && !inWs(t) && t.canMove() && t.el.matches('[open],.open')) { const r = t.el.getBoundingClientRect(); setPos(t, r.left, r.top); }
}
const schedule = (() => { let f = 0; return () => { if (f) return; f = requestAnimationFrame(() => { f = 0; refreshWorkspace(); reflowPopups(); }); }; })();

// ---------- commit (only on pointerup / keyboard step, never while moving) ----------
function commit(t, resized) {
  const r = t.el.getBoundingClientRect(), o = orient();
  if (ws.enabled && t.def && !t.def.popup) { ws[o][gid(t)] = geomOf(t); saveWS(); return; }
  const rec = [r.left, r.top];
  if (t.def?.popup && (resized || saved[t.id]?.[2])) rec.push(r.width);   // width is only remembered once the user has chosen one
  saved[t.id] = rec; savePopups();
}
function resetOne(t) {
  const o = orient();
  if (ws.enabled && t.def && !t.def.popup) { delete ws[o][gid(t)]; saveWS(); }
  if (inWs(t)) return refreshWorkspace();
  delete saved[t.id]; savePopups(); if (t.def && t.id === 'dlg') t.el.style.removeProperty('width'); t.place();
}

// ---------- pointer + keyboard behaviour shared by every move handle and resize grip ----------
const flag = (t, on) => t.el.classList.toggle('flActive', on);
function bindHandle(t, h) {
  let drag = null, raf = 0;
  h.addEventListener('pointerdown', e => {
    if (e.button || !t.canMove()) return;
    const r = t.el.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    h.setPointerCapture(e.pointerId); e.preventDefault(); raise(t); flag(t, true);
  });
  h.addEventListener('pointermove', e => {
    if (!drag) return; drag.x = e.clientX - drag.dx; drag.y = e.clientY - drag.dy;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (drag) setPos(t, drag.x, drag.y); });
  });
  const end = () => {
    if (!drag) return; cancelAnimationFrame(raf); raf = 0;
    if (drag.x != null) setPos(t, drag.x, drag.y);
    drag = null; flag(t, false); commit(t);
  };
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
  h.addEventListener('dblclick', () => { if (t.canMove()) resetOne(t); });
  h.addEventListener('keydown', e => {
    if (!t.canMove() || e.altKey || e.ctrlKey || e.metaKey) return;
    const s = e.shiftKey ? 64 : 16, r = t.el.getBoundingClientRect();
    const mv = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key];
    if (mv) { e.preventDefault(); setPos(t, r.left + mv[0], r.top + mv[1]); commit(t); return; }
    const grow = { '+': s, '=': s, '-': -s, _: -s }[e.key];   // keyboard resize that leaves the arrow keys to movement
    if (grow && t.canResize()) { e.preventDefault(); resizeBy(t, grow, t.def.flex && !pinned(t) ? null : grow); }
  });
  h.addEventListener('focus', () => raise(t));
}
function resizeBy(t, dw, dh) {
  const r = t.el.getBoundingClientRect(), a = area(), ax = t.def.axes;
  if (ax === 's') setSize(t, r.width + dw, 0);
  else if (t.def.popup) setSize(t, Math.min(r.width + dw, a.x1 - r.left));
  else setSize(t, r.width + dw, ax === 'xy' && dh != null ? r.height + dh : null);
  setPos(t, r.left, r.top); commit(t, true);
}
function bindGrip(t, g) {
  let rs = null, raf = 0;
  const apply = e => {
    const a = area(), r = t.el.getBoundingClientRect(), dx = e.clientX - rs.x, dy = e.clientY - rs.y, ax = t.def.axes;
    if (ax === 's') { const d = Math.abs(dx) >= Math.abs(dy) ? dx : dy; setSize(t, rs.w + d, 0); setPos(t, r.left, r.top); }   // no maximum: the board grows past the screen and is panned with its strip
    else if (t.def.popup) { setSize(t, rs.w + dx); setPos(t, r.left, r.top); }   // a popup against the right edge grows by sliding left instead of refusing
    else if (t.def.flex) {   // width always; height only once the player really drags vertically (then it stays pinned and the content fits the box)
      rs.v ||= rs.pin || Math.abs(dy) > 6;
      setSize(t, rs.w + dx, rs.v ? rs.h + dy : null); setPos(t, r.left, r.top);
    } else { setSize(t, rs.w + dx, ax === 'xy' ? rs.h + dy : null); if (ax === 'x') setPos(t, r.left, r.top); }
  };
  g.addEventListener('pointerdown', e => {
    if (e.button || !t.canResize()) return;
    const r = t.el.getBoundingClientRect(); rs = { x: e.clientX, y: e.clientY, w: r.width, h: r.height, pin: pinned(t), v: false };
    g.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); raise(t); flag(t, true);
  });
  g.addEventListener('pointermove', e => { if (rs && !raf) raf = requestAnimationFrame(() => { raf = 0; if (rs) apply(e); }); });
  const end = e => {
    if (!rs) return; cancelAnimationFrame(raf); raf = 0;
    if (e.type === 'pointerup') apply(e);
    rs = null; flag(t, false); commit(t, true);
  };
  g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
  g.addEventListener('keydown', e => {
    const s = e.shiftKey ? 64 : 16, d = { ArrowRight: s, ArrowDown: s, ArrowLeft: -s, ArrowUp: -s }[e.key];
    if (!d || !t.canResize()) return;
    e.preventDefault();
    if (!t.def.flex) return resizeBy(t, d, d);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') resizeBy(t, d, null);   // horizontal keys: width only
    else resizeBy(t, 0, d);                                                       // vertical keys: height only (pins it)
  });
  g.addEventListener('dblclick', () => { if (t.canResize()) resetOne(t); });
}
const GRIP = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10L10 20M20 16l-4 4"/></svg>';
function addChrome(t) {
  if (t.chrome) return; t.chrome = [];
  if (!t.isPopup) {   // modules without a title bar get a slim move strip (word log and dialogue reuse their title)
    const h = document.createElement('button'); h.type = 'button'; h.className = 'flMove';
    t.el.prepend(h); bindHandle(t, h); t.chrome.push(h);
  }
  const g = document.createElement('button'); g.type = 'button'; g.className = 'flGrip'; g.innerHTML = GRIP;
  t.el.append(g); bindGrip(t, g); t.chrome.push(g);
  relabel(t);
}
// The handles' accessible names mention the module (for the players: the player's current name), so they are rewritten when a name changes.
function relabel(t) {
  for (const n of t.chrome || []) {
    if (n.classList.contains('flMove')) { n.setAttribute('aria-label', `تحريك ${t.def.label}: الأسهم للتحريك، + و − للحجم، نقر مزدوج لإعادة الضبط`); n.title = 'اسحب لتحريك ' + t.def.label; }
    else { n.setAttribute('aria-label', `تغيير حجم ${t.def.label}: الأسهم`); n.title = 'اسحب لتغيير الحجم'; }
  }
}
onNamesChange(() => { for (const id of ['p0', 'p1']) if (things[id]) relabel(things[id]); });
const removeChrome = t => { (t.chrome || []).forEach(n => n.remove()); t.chrome = null; };
const clearInline = t => { clearFit(t); for (const p of ['left', 'top', 'width', 'height', 'z-index', '--float-board-size', '--fu']) t.el.style.removeProperty(p); };

// ---------- vertical fit (player panels, Turn Controls, Game Tools) ----------
const pinned = t => !!t.def?.flex && !!t.el.style.height;
function clearFit(t) {
  if (!t.def?.flex) return;
  const el = t.el; el.removeAttribute('data-vfit');
  el.style.removeProperty('--cc'); el.style.removeProperty('--bu');
  const rk = el.querySelector('.rack');
  if (!rk) return;
  for (const p of ['--ts', 'padding', 'gap', 'grid-template-columns', 'grid-auto-rows']) rk.style.removeProperty(p);
  for (const sl of rk.children) { sl.style.removeProperty('grid-row'); sl.style.removeProperty('grid-column'); }
}
function fitContent(t) {
  if (!t.def?.flex) return;
  const on = inWs(t) && pinned(t) && !(t.id === 'tools' && toolsMin());
  if (!on) { if (t.el.hasAttribute('data-vfit')) clearFit(t); return; }
  if (!t.el.hasAttribute('data-vfit')) t.el.setAttribute('data-vfit', '');
  if (t.el.querySelector('.rack')) fitRack(t); else fitButtons(t);
}
// Rack: the n slots are laid out in r balanced rows (7 -> 7 | 4+3 | 3+2+2 | 2+2+2+1 | 1x7); r is whichever gives the biggest SQUARE tile in the tray, and rows with fewer
// tiles are centred (the grid has two half-columns per tile, a short row starts half a tile in per missing tile). The tray itself fills the panel; type scales with the tile (--ts).
function fitRack(t) {
  const rk = t.el.querySelector('.rack'), slots = rk ? [...rk.children].filter(n => n.classList.contains('slot')) : [], n = slots.length;
  if (!n) return;
  const W = rk.clientWidth, H = rk.clientHeight;
  if (W < 8 || H < 8) return;
  const p = Math.max(3, 0.018 * Math.max(W, H)), g = p * 0.67;
  let best = null;
  for (let r = 1; r <= n; r++) {
    const c = Math.ceil(n / r), s = Math.min((W - 2 * p - g * (c - 1)) / c, (H - 2 * p - g * (r - 1)) / r);
    if (!best || s > best.s + 0.5) best = { r, c, s };
  }
  const { r, c } = best, s = Math.max(g + 4, best.s), base = Math.floor(n / r), extra = n % r;
  rk.style.setProperty('--ts', s.toFixed(2) + 'px');
  rk.style.padding = p.toFixed(2) + 'px'; rk.style.gap = g.toFixed(2) + 'px';
  rk.style.gridTemplateColumns = `repeat(${2 * c}, ${((s - g) / 2).toFixed(2)}px)`; rk.style.gridAutoRows = s.toFixed(2) + 'px';
  let i = 0;
  for (let row = 0; row < r; row++) {
    const cnt = base + (row < extra ? 1 : 0);
    for (let j = 0; j < cnt; j++, i++) { slots[i].style.gridRow = String(row + 1); slots[i].style.gridColumn = `${c - cnt + 1 + 2 * j} / span 2`; }
  }
}
// Buttons: pick the column count whose cells come closest to (or beyond) the button's natural size on BOTH axes, then let every row share the height; all cells stay equal and a short last row is centred. --bu = how much bigger/smaller than natural the cells are; type and icons follow it, so the box decides the button size.
function fitButtons(t) {
  const el = t.el, cs = getComputedStyle(el), f = k => parseFloat(cs[k]) || 0;
  const btns = [...el.children].filter(b => b.classList.contains('btn') && getComputedStyle(b).display !== 'none'), n = btns.length;
  if (!n) return;
  const W = el.clientWidth - f('paddingLeft') - f('paddingRight'), H = el.clientHeight - f('paddingTop') - f('paddingBottom'), g = f('columnGap');
  if (W < 8 || H < 8) return;
  const nw = { icon: 44, iconlabel: 64, text: 84 }[html().dataset.bstyle] || 44, nh = parseFloat(cs.getPropertyValue('--b-h')) || 46;
  let best = null;
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c), sc = Math.min(((W - g * (c - 1)) / c) / nw, ((H - g * (r - 1)) / r) / nh);
    if (!best || sc > best.sc * 1.02) best = { c, sc };
  }
  el.style.setProperty('--cc', String(best.c)); el.style.setProperty('--bu', Math.max(0.3, best.sc).toFixed(3));
}

// ---------- popups: settings, gameplay dialogue, word-log drawer ----------
const isFixed = t => getComputedStyle(t.el).position === 'fixed' && !t.el.classList.contains('dlgModal');
// opts.def: DEFS entry that makes this popup resizable: 'hist' only while Floating Workspace is ON, 'dlg' always
export function makeFloating(el, id, handle, defPos, opts = {}) {
  const t = things[id] = { id, el, handle, def: opts.def ? DEFS[opts.def] : null, isPopup: true };
  t.canMove = () => isFixed(t);
  t.canResize = () => !!t.def && (t.def.popup || ws.enabled) && isFixed(t);   // the dialogue never needs the workspace
  t.place = () => {
    if (inWs(t)) return refreshWorkspace();
    if (t.def?.popup) { const w = saved[id]?.[2]; if (w) setSize(t, w); else el.style.removeProperty('width'); }   // width first: the default spot depends on it
    const p = saved[id] || defPos(el); setPos(t, p[0], p[1]);
  };
  handle.classList.add('floatHandle'); handle.tabIndex = 0;
  handle.title = 'اسحب لتحريك النافذة · مزدوج النقر لإعادة الموضع';
  el.addEventListener('pointerdown', () => raise(t), true);
  bindHandle(t, handle);
}
export function showFloat(id) { const t = things[id]; if (t) { t.place(); raise(t); } }
// Default spot for the gameplay dialogue: the free corner/edge that hides the least of the board, the racks and the controls.
export function autoPos(el) {
  const a = area(), w = el.offsetWidth, h = el.offsetHeight;
  const rects = [['#board', 4], ['.panel.on .rack', 5], ['.rack', 2], ['.ctrls', 2.5], ['.panel', 1]]
    .flatMap(([s, k]) => [...document.querySelectorAll(s)].map(n => [n.getBoundingClientRect(), k])).filter(([r]) => r.width && r.height);
  const xs = [a.x0, (a.x0 + a.x1 - w) / 2, a.x1 - w], ys = [a.y0, (a.y0 + a.y1 - h) / 2, a.y1 - h];
  const tries = orient() === 'portrait' ? [[1, 0], [1, 2], [0, 0], [2, 0], [0, 2], [2, 2], [0, 1], [2, 1], [1, 1]]
    : [[0, 0], [2, 0], [0, 2], [2, 2], [0, 1], [2, 1], [1, 0], [1, 2], [1, 1]];
  let best = null;
  for (const [i, j] of tries) {
    const x = xs[i], y = ys[j]; let sc = 0;
    for (const [r, k] of rects) sc += k * Math.max(0, Math.min(x + w, r.right) - Math.max(x, r.left)) * Math.max(0, Math.min(y + h, r.bottom) - Math.max(y, r.top));
    if (!best || sc < best.sc - 1) best = { sc, x, y };
  }
  return [best.x, best.y];
}
// Resets popup positions and workspace geometry only; theme, layout, game state and history are not touched.
export function resetFloats() {
  saved = {}; savePopups(); ws.portrait = {}; ws.landscape = {}; saveWS();
  if (ws.enabled) refreshWorkspace();
  for (const t of Object.values(things)) if (t.isPopup && !inWs(t) && t.canMove() && t.el.matches('[open],.open')) { if (t.id === 'dlg') t.el.style.removeProperty('width'); t.place(); }
}

// ---------- input lock: how a dialogue looks never decides whether the game behind it can be touched ----------
const locks = new Set();
function applyLocks() {
  document.querySelectorAll('.app > *').forEach(n => { n.inert = locks.has('dlg') || (locks.has('settings') && n.id !== 'hist'); });
}
export function lockGame(reason, on) { if (on) locks.add(reason); else locks.delete(reason); applyLocks(); }
// While the settings window floats (non-modal) the game behind it stays frozen, exactly as the old modal did.
export const gameInert = on => lockGame('settings', on);

// Ctrl/⌘ + wheel over a module (a trackpad pinch arrives the same way) resizes it around the pointer: the quickest way to size anything, at any scale.
// The module stays marked active until the wheel pauses, so the layout refresh never fights the gesture; the result is committed once.
function bindWheel(t) {
  let timer = 0;
  t.el.addEventListener('wheel', e => {
    if (!ws.enabled || !(e.ctrlKey || e.metaKey) || !t.canResize()) return;
    e.preventDefault();
    const r = t.el.getBoundingClientRect(), f = Math.exp(-clamp(e.deltaY, -120, 120) * 0.0016);
    flag(t, true);
    setSize(t, r.width * f, t.def.axes === 'xy' && (!t.def.flex || pinned(t)) ? r.height * f : null);
    const n = t.el.getBoundingClientRect();
    setPos(t, e.clientX - (e.clientX - r.left) * (n.width / r.width), e.clientY - (e.clientY - r.top) * (n.height / r.height));
    clearTimeout(timer); timer = setTimeout(() => { flag(t, false); commit(t, true); }, 220);
  }, { passive: false });
}

// ---------- Floating Workspace on/off ----------
export const isFloating = () => ws.enabled;
export function initWorkspace() {   // after buildDom(): the player panels exist now
  for (const id of ['board', 'p0', 'p1', 'ctrls', 'tools']) {
    const el = document.querySelector(DEFS[id].sel);
    const t = things[id] = { id, el, def: DEFS[id], isPopup: false, canMove: () => ws.enabled, canResize: () => ws.enabled && !(id === 'tools' && toolsMin()) };
    if (id !== 'board') el.addEventListener('pointerdown', () => raise(t), true);   // board interaction never takes part in foreground ordering
    bindWheel(t);
  }
  // Content can change a module's height after layout (counter row, rack, labels, fonts): re-fit then, but never while the user is dragging one.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => { if (ws.enabled) for (const id of ['p0', 'p1', 'ctrls', 'tools']) fitContent(things[id]); if (ws.enabled && !document.querySelector('.flActive')) schedule(); });
    for (const id of ['board', 'p0', 'p1', 'ctrls', 'tools']) ro.observe(things[id].el);
    for (const id of ['p0', 'p1']) { const rk = things[id].el.querySelector('.rack'); if (rk) ro.observe(rk); }   // the tray's own box changes with the header
  }
  // The game redraws the racks' slots after every move: lay the fresh slots out again (a no-op unless the panel's height is pinned).
  if (typeof MutationObserver !== 'undefined') for (const id of ['p0', 'p1']) {
    const rk = things[id].el.querySelector('.rack'); if (rk) new MutationObserver(() => { if (ws.enabled) fitContent(things[id]); }).observe(rk, { childList: true });
  }
  if (things.dlg) addChrome(things.dlg);   // the dialogue's grip is permanent; the workspace modules get theirs only while ON
  addEventListener('resize', schedule); addEventListener('orientationchange', schedule);
  document.fonts?.ready.then(schedule);
  if (ws.enabled) enter();
}
// Game Tools: the five tool buttons are moved into #tools while the workspace is ON and back, in their original order, when it is OFF. Same elements (listeners, ids,
// state intact), so the structured default layout is exactly the single group it always was.
const TOOL_IDS = ['bJudge', 'bLog', 'bFs', 'bSettings', 'bNew'];
let homeOrder = null;
function dockTools(on) {
  const turn = document.querySelector('.ctrls:not(#tools)'), tools = document.getElementById('tools');
  if (!turn || !tools) return;
  if (on) {
    homeOrder ??= [...turn.querySelectorAll(':scope > .btn')].map(b => b.id);
    tools.classList.add('ctrls');   // it is a button rack like the other one: every .ctrls rule (grid, button styles, container sizing) applies
    for (const id of TOOL_IDS) { const b = document.getElementById(id); if (b) tools.append(b); }
    ensureToggle(tools);
  } else {
    document.getElementById('toolsToggle')?.remove();
    delete tools.dataset.min;
    tools.classList.remove('ctrls');
    for (const id of homeOrder || []) { const b = document.getElementById(id); if (b) turn.append(b); }
  }
}
// ---- Game Tools: minimize / restore ----
const ICON = { fold: 'M5 12h14', apps: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z' };
function syncTools() {   // idempotent: touches the DOM only when something actually changed, so a refresh never invalidates styles for nothing
  const t = things.tools; if (!t) return;
  const min = toolsMin(), v = String(min);
  if (t.el.dataset.min !== v) t.el.dataset.min = v;
  const b = document.getElementById('toolsToggle'); if (!b) return;
  const txt = min ? 'أدوات اللعبة' : 'طي أدوات اللعبة', path = b.querySelector('path'), d = min ? ICON.apps : ICON.fold;
  if (b.getAttribute('aria-expanded') !== String(!min)) b.setAttribute('aria-expanded', String(!min));
  if (b.getAttribute('aria-label') !== txt) { b.setAttribute('aria-label', txt); b.title = txt; }
  if (path.getAttribute('d') !== d) path.setAttribute('d', d);
}
// Collapse/expand around the corner nearest to the module, so the module grows out of (or shrinks into) the spot the user tapped, then remember the result.
function setToolsMin(min) {
  const t = things.tools, o = orient(), a = area();
  if (!t || !ws.enabled || min === toolsMin()) return;
  const r = t.el.getBoundingClientRect(), right = r.left + r.width / 2 > (a.x0 + a.x1) / 2, bottom = r.top + r.height / 2 > (a.y0 + a.y1) / 2;
  // Toggling a secondary tool must not shift anything else: modules still following the computed defaults (which depend on this state, e.g. the board height in
  // portrait) are pinned where they are right now before the state changes.
  for (const m of Object.values(things)) if (m.def && !m.def.popup && !ws[o][gid(m)]) ws[o][gid(m)] = geomOf(m);
  if (min) ws[o].tools = geomOf(t);   // the expanded layout is kept, so restoring brings back the size the user had
  ws.tools = min ? 'min' : 'open'; syncTools(); fitContent(t);
  if (!min) { const sv = ws[o].tools; if (sv?.h == null) t.el.style.removeProperty('height'); setSize(t, sv?.w ?? clamp(Math.round(Math.min(a.w, a.h) * 0.62), 160, limits(t).maxW), sv?.h); }
  const n = t.el.getBoundingClientRect();
  let y = bottom ? r.bottom - n.height : r.top;
  const c = things.ctrls && things.ctrls.el.getBoundingClientRect();   // Turn Controls are the frequent controls: a restored module slides clear of them, away from the edge it grew from
  if (!min && c && n.left < c.right && n.left + n.width > c.left && y < c.bottom && y + n.height > c.top) y = bottom ? c.top - 8 - n.height : c.bottom + 8;
  setPos(t, right ? r.right - n.width : r.left, y);
  commit(t);   // files the geometry under the new state's key and persists the state
}
function ensureToggle(tools) {
  let b = document.getElementById('toolsToggle'); if (b) return b;
  b = document.createElement('button'); b.type = 'button'; b.id = 'toolsToggle'; b.className = 'toolsToggle'; b.setAttribute('aria-controls', 'tools');
  b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path/></svg>';
  tools.append(b); bindToolsToggle(things.tools, b); return b;
}
// Expanded: a plain collapse button. Minimized: the button IS the module, so the same element is also its drag handle (a short press toggles, a drag moves).
function bindToolsToggle(t, b) {
  let d = null, swallow = false;
  b.addEventListener('pointerdown', e => {
    if (e.button || !toolsMin()) return;
    const r = t.el.getBoundingClientRect(); d = { x: e.clientX, y: e.clientY, ox: e.clientX - r.left, oy: e.clientY - r.top, moved: false };
    try { b.setPointerCapture(e.pointerId); } catch { /* not capturable: dragging just ends on release */ }
  });
  b.addEventListener('pointermove', e => {
    if (!d) return;
    if (!d.moved) { if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return; d.moved = true; t.el.classList.add('flActive'); }
    setPos(t, e.clientX - d.ox, e.clientY - d.oy);
  });
  const end = () => {
    if (!d) return; const moved = d.moved; d = null; t.el.classList.remove('flActive');
    if (moved) { swallow = true; setTimeout(() => { swallow = false; }, 0); commit(t); }   // the click that follows a drag must not toggle
  };
  b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end);
  b.addEventListener('click', () => { if (swallow) { swallow = false; return; } setToolsMin(!toolsMin()); });
  b.addEventListener('keydown', e => {
    if (!toolsMin() || !e.key.startsWith('Arrow')) return;
    e.preventDefault(); const step = e.shiftKey ? 48 : 12, r = t.el.getBoundingClientRect();
    setPos(t, r.left + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0), r.top + (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0)); commit(t);
  });
}
function enter() {
  html().dataset.floating = 'true';
  dockTools(true);
  for (const t of Object.values(things)) if (t.def) addChrome(t);
  for (const b of Object.values(order)) b.length = 0;
  for (const t of Object.values(things)) if (t.def && !t.def.popup) t.el.style.removeProperty('z-index');   // stale inline z-index never overrides the layering
  refreshWorkspace();
  for (const id of ['board', 'p0', 'p1', 'ctrls', 'tools']) raise(id);
  if (things.hist) raise('hist');
}
function leave() {
  delete html().dataset.floating;
  for (const t of Object.values(things)) {
    if (!t.def) continue;
    if (t.def.popup) continue;   // the dialogue is independent of the workspace
    removeChrome(t); clearInline(t);
  }
  dockTools(false);
  for (const b of Object.values(order)) b.length = 0;
  const h = things.hist; if (h && h.el.classList.contains('open')) showFloat('hist');   // drawer open: back to its remembered popup spot
}
export function setFloating(on) {
  on = !!on; if (on === ws.enabled) return;
  ws.enabled = on; saveWS();
  if (on) enter(); else leave();
}
// Layout preference / dimension change while ON: modules without an override follow the new defaults.
export const refresh = schedule;
