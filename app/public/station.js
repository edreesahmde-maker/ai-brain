// AI Brain - the workstation: dockable panels, splitters, layout presets, the usage panel,
// music controls, the Discord app panel, work modes and the status bar. Uses the helpers app.js
// exposes on window.Brain. Everything here also works in a plain browser tab (for tests);
// the desktop shell adds window.station (full screen, window buttons, Discord beside AI Brain).
(() => {
  "use strict";
  const B = window.Brain;
  if (!B) return;
  const { $, $$, h, icon, api, tryApi, toast, store } = B;
  const root = document.documentElement;
  const shell = window.station && window.station.shell ? window.station : null;

  // ---------- panels and layouts ----------
  // The work area is a tree of rows and columns. Its leaves are the side panels, the chat ("main")
  // and the program in the middle ("app"). A node is a leaf id, or { d: "r" (side by side) or
  // "c" (stacked), k: [children], s: [weights] }. Every leaf element stays a direct child of #tiles
  // and is only given a position, never moved in the page, so the chat keeps its scroll and focus.
  // With free-floating panels on, each leaf has its own spot and size instead (L.fl, in parts of
  // the work area) and a stacking order (L.z).
  const PANELS = {
    gemini: { label: "Gemini", icon: "star", side: "left", f: 1.6 },
    chatgpt: { label: "ChatGPT", icon: "users", side: "left", f: 1.2 },
    activity: { label: "Activity", icon: "activity", side: "left", f: 1 },
    usage: { label: "Usage", icon: "gauge", side: "right", f: 2.1 },
    stats: { label: "This session", icon: "bars", side: "right", f: 0.5 },
    recent: { label: "Recent images", icon: "image", side: "left", f: 0.7 },
    music: { label: "Music", icon: "music", side: "right", f: 0.8 },
    discord: { label: "Discord", icon: "chat", side: "right", f: 2.2 },
    apps: { label: "Apps", icon: "window", side: "left", f: 1.2 },
  };
  const IDS = Object.keys(PANELS);
  const LEAVES = ["main", "app", ...IDS];
  const leafName = (id) => (id === "main" ? "Chat" : id === "app" ? "Program" : PANELS[id]?.label || id);
  const SIDES = ["left", "right", "top", "bottom"];
  const chatgptOn = () => !!B.S.settings?.chatgptEnabled;
  const usable = (id) => id !== "chatgpt" || chatgptOn();
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const col = (...ids) => (ids.length === 1 ? ids[0] : { d: "c", k: ids, s: ids.map((id) => PANELS[id].f) });
  const rowOf = (...pairs) => ({ d: "r", k: pairs.map((p) => p[0]), s: pairs.map((p) => p[1]) });
  // Weights are about the pixel widths on a normal screen. While no program is shown, the
  // program's share goes to the chat.
  const PRESETS = {
    focus: () => rowOf(["app", 900], ["main", 700]),
    station: () => rowOf([col("gemini", "activity"), 310], ["app", 560], ["main", 440], [col("usage", "music", "stats"), 300]),
    all: () => rowOf([col("gemini", ...(chatgptOn() ? ["chatgpt"] : []), "activity", "recent"), 310], ["app", 520], ["main", 440], [col("usage", "music", "discord", "stats"), 330]),
    social: () => rowOf(["gemini", 300], ["app", 460], ["main", 440], [col("discord", "music"), 440]),
  };
  const PRESET_NAMES = { focus: "Focus", station: "Station", all: "Everything", social: "Social", mine: "Mine" };

  // ----- the tree -----
  const isNode = (n) => !!n && typeof n === "object";
  const leavesOf = (n, out = []) => { if (typeof n === "string") out.push(n); else if (isNode(n)) n.k.forEach((c) => leavesOf(c, out)); return out; };
  const holds = (n, id) => n === id || (isNode(n) && n.k.some((c) => holds(c, id)));
  function where(n, id, p = null, i = -1) {
    if (n === id) return { p, i };
    if (isNode(n)) for (let j = 0; j < n.k.length; j++) { const f = where(n.k[j], id, n, j); if (f) return f; }
    return null;
  }
  const r3 = (v) => Math.max(0.001, Math.round(v * 1000) / 1000);
  // Tidy a tree: no empty nodes, no node with one child, no row inside a row (or column in a column).
  function norm(n) {
    if (!isNode(n)) return n || null;
    const k = [], s = [];
    n.k.forEach((c, i) => {
      const x = norm(c);
      if (!x) return;
      if (isNode(x) && x.d === n.d) {
        const sum = x.s.reduce((a, b) => a + b, 0) || 1;
        x.k.forEach((cc, j) => { k.push(cc); s.push(r3(n.s[i] * x.s[j] / sum)); });
      } else { k.push(x); s.push(r3(n.s[i])); }
    });
    if (!k.length) return null;
    return k.length === 1 ? k[0] : { d: n.d, k, s };
  }
  function cut(t, id) {
    const f = where(t, id);
    if (!f) return t;
    if (!f.p) return null;
    f.p.k.splice(f.i, 1); f.p.s.splice(f.i, 1);
    return norm(t);
  }
  // Put a leaf beside a target leaf, or along an edge of the whole work area (target "*").
  function put(t, id, target, side) {
    const d = side === "left" || side === "right" ? "r" : "c", after = side === "right" || side === "bottom";
    if (!t) return id;
    if (target === "*" || !holds(t, target)) {
      const r = isNode(t) && t.d === d ? t : { d, k: [t], s: [1] };
      const w = r3(r.s.reduce((a, b) => a + b, 0) * 0.28);
      if (after) { r.k.push(id); r.s.push(w); } else { r.k.unshift(id); r.s.unshift(w); }
      return norm(r);
    }
    const f = where(t, target);
    const pair = { d, k: after ? [target, id] : [id, target], s: [1, 1] };
    if (!f.p) return pair;
    if (f.p.d === d) {
      const half = r3(f.p.s[f.i] / 2), at = f.i + (after ? 1 : 0);
      f.p.s[f.i] = half;
      f.p.k.splice(at, 0, id); f.p.s.splice(at, 0, half);
    } else f.p.k[f.i] = pair;
    return norm(t);
  }
  const swapIn = (n, a, b) => (n === a ? b : n === b ? a : isNode(n) ? { ...n, k: n.k.map((c) => swapIn(c, a, b)) } : n);
  function cleanTree(n, seen, depth) {
    if (typeof n === "string") { if (!LEAVES.includes(n) || seen.has(n)) return null; seen.add(n); return n; }
    if (!isNode(n) || depth > 6 || (n.d !== "r" && n.d !== "c") || !Array.isArray(n.k)) return null;
    const k = [], s = [];
    n.k.slice(0, 16).forEach((c, i) => {
      const x = cleanTree(c, seen, depth + 1);
      if (!x) return;
      const w = Number(Array.isArray(n.s) ? n.s[i] : 1);
      k.push(x); s.push(w > 0.0005 && w < 1e5 ? r3(w) : 1);
    });
    return k.length ? { d: n.d, k, s } : null;
  }
  // The chat is always there, and so is the program's place (it only shows while a program is in it).
  function fixTree(t) {
    const seen = new Set();
    let n = norm(cleanTree(t, seen, 0));
    if (!seen.has("main")) n = n ? put(n, "main", "*", "right") : "main";
    if (!seen.has("app")) n = put(n, "app", "main", "left");
    return n;
  }
  // Layouts saved before the tree: a left and a right column of panels.
  function migrate(x) {
    const side = (s) => (Array.isArray(s?.items) ? s.items : []).filter((id) => PANELS[id]);
    const colOf = (ids) => (ids.length === 1 ? ids[0] : { d: "c", k: ids, s: ids.map((id) => Number(x.sizes?.[id]) || PANELS[id].f) });
    const l = side(x.left), r = side(x.right), k = [], s = [];
    if (l.length) { k.push(colOf(l)); s.push(Number(x.left.w) || 300); }
    k.push("app", "main"); s.push(560, Number(store.get("chatW", 440)) || 440);
    if (r.length) { k.push(colOf(r)); s.push(Number(x.right.w) || 300); }
    return { d: "r", k, s };
  }
  const treeOf = (o) => fixTree(o.root !== undefined ? o.root : o.left || o.right ? migrate(o) : null);
  function cleanFl(f) {
    const out = {};
    if (!isNode(f)) return out;
    for (const id of LEAVES) {
      const v = f[id];
      if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => Number.isFinite(n))) continue;
      const [x, y, w, h] = v;
      if (x > -1 && x < 1 && y > -0.1 && y < 1 && w > 0.02 && w <= 1.01 && h > 0.02 && h <= 1.01) out[id] = v.map((n) => Math.round(n * 10000) / 10000);
    }
    return out;
  }
  const cleanIds = (a) => [...new Set((Array.isArray(a) ? a : []).filter((id) => LEAVES.includes(id)))];

  let L = fromPreset("station");
  let lastSaved = "";
  function fromPreset(name, base) {
    const p = name === "mine" ? base?.mine : PRESETS[name] ? { root: PRESETS[name](), collapsed: [], fl: {} } : null;
    if (!p) return null;
    return { v: 2, preset: name, root: fixTree(clone(p.root)), collapsed: [...(p.collapsed || [])], home: base?.home || {},
      mine: base?.mine || null, float: !!base?.float, fl: clone(p.fl || {}), z: [] };
  }
  function clean(x) {
    // Never trust a saved layout blindly: known leaves only, each once, sane sizes.
    if (!isNode(x)) return null;
    const home = {};
    if (isNode(x.home)) for (const id of IDS) { const v = x.home[id]; if (isNode(v) && LEAVES.includes(v.near) && SIDES.includes(v.side)) home[id] = { near: v.near, side: v.side }; }
    const out = { v: 2, preset: typeof x.preset === "string" ? x.preset : "", root: treeOf(x), collapsed: cleanIds(x.collapsed).filter((id) => PANELS[id]),
      home, mine: null, float: x.float === true, fl: cleanFl(x.fl), z: cleanIds(x.z) };
    if (isNode(x.mine)) out.mine = { root: treeOf(x.mine), collapsed: cleanIds(x.mine.collapsed).filter((id) => PANELS[id]), fl: cleanFl(x.mine.fl) };
    return out;
  }
  const serial = () => JSON.stringify(L);
  let saveTimer = 0;
  function save() {
    store.set("layout", L);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const text = serial();
      if (text === lastSaved) return;
      if (text.length > 6000) return; // the server limit; a layout is far smaller than this
      lastSaved = text;
      await tryApi("/api/settings", { layout: text });
    }, 500);
  }
  function changed() { L.preset = ""; render(); save(); }

  // ---------- rail buttons and panel heads ----------
  const tiles = $("#tiles");
  const railBtns = {};
  const panelEl = (id) => $(`[data-panel="${id}"]`);
  const leafEl = (id) => (id === "main" ? $("#main") : id === "app" ? $("#appview") : panelEl(id));
  for (const id of IDS) {
    const p = PANELS[id];
    const b = h("button", { type: "button", class: "icon-btn", "data-toggle": id, title: `${p.label} – show or hide`, "aria-label": `Show or hide ${p.label}`, "aria-pressed": "false" }, icon(p.icon));
    b.addEventListener("click", () => (isShown(id) ? hide(id) : show(id)));
    railBtns[id] = b;
    $("#rail-panels").append(b);
    const panel = panelEl(id);
    const head = $(".p-head", panel);
    const more = h("button", { type: "button", class: "icon-btn p-more", title: "Panel menu: move, resize or hide", "aria-label": `${p.label} panel menu`, "aria-haspopup": "menu" }, icon("dots"));
    more.addEventListener("click", (e) => { e.stopPropagation(); panelMenu(id, more); });
    head.append(more);
    head.addEventListener("dblclick", (e) => { if (!e.target.closest("button, input, textarea, select, a")) toggleCollapse(id); });
    tiles.append(panel); // once; from now on panels are only positioned
  }
  const HANDLE = { main: "#stage", app: ".av-head" };
  for (const id of LEAVES) {
    const el = leafEl(id);
    el.classList.add("leaf");
    el.dataset.leaf = id;
    const handle = HANDLE[id] ? $(HANDLE[id], el) : $(".p-head", el);
    handle.classList.add("grab");
    handle.title = handle.title || `Drag to move ${leafName(id) === "Chat" ? "the chat" : leafName(id)}`;
    handle.addEventListener("pointerdown", (e) => grab(e, id));
    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"]) {
      const rz = h("div", { class: `rz rz-${dir}`, "aria-hidden": "true" });
      rz.addEventListener("pointerdown", (e) => resizeFloat(e, id, dir));
      el.append(rz);
    }
  }
  const inTree = (id) => holds(L.root, id);
  const isShown = (id) => !!PANELS[id] && inTree(id) && usable(id);
  const isZen = () => document.body.classList.contains("zen");

  function show(id, opts = {}) {
    if (!PANELS[id]) return;
    if (!usable(id)) { toast("Turn ChatGPT on in Settings first."); return; }
    if (isZen()) { B.setZen(false); layout(); }
    if (!inTree(id)) {
      const home = L.home?.[id];
      if (!opts.side && home && home.near !== id && inTree(home.near)) L.root = put(L.root, id, home.near, home.side);
      else toSide(id, opts.side || PANELS[id].side);
    }
    L.collapsed = L.collapsed.filter((x) => x !== id);
    if (L.float) raise(id, true);
    changed();
    const el = panelEl(id);
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    if (id === "discord") discordWanted();
    if (id === "apps") refreshApps();
  }
  function hide(id) {
    const f = where(L.root, id);
    if (!f || !PANELS[id]) return;
    if (f.p) {
      // Remember the neighbour, so the rail button brings it back to the same place.
      const before = f.i > 0, sib = leavesOf(f.p.k[before ? f.i - 1 : f.i + 1]);
      const side = f.p.d === "c" ? (before ? "bottom" : "top") : (before ? "right" : "left");
      L.home = { ...(L.home || {}), [id]: { near: before ? sib[sib.length - 1] : sib[0], side } };
    }
    L.root = cut(L.root, id);
    const max = $(".panel.max");
    if (max && max === panelEl(id)) B.toggleMax(max, false);
    changed();
  }
  function toggleCollapse(id) {
    L.collapsed = L.collapsed.includes(id) ? L.collapsed.filter((x) => x !== id) : [...L.collapsed, id];
    changed();
  }
  // Up and down: trade places with whatever is right above or below on screen.
  function move(id, delta) {
    const nb = neighbour(id, delta);
    if (!nb) return;
    L.root = swapIn(L.root, id, nb);
    changed();
  }
  // To the left or right edge: under the lowest panel there, or as a new column along that edge.
  function toSide(id, side) {
    if (inTree(id)) L.root = cut(L.root, id);
    const g = gap(), W = tiles.clientWidth;
    const along = Object.entries(RECTS).filter(([k, r]) => k !== id && PANELS[k] && inTree(k)
      && (side === "left" ? r.x <= g + 1 : r.x + r.w >= W - g - 1));
    const pick = along.sort((a, b) => (b[1].y + b[1].h) - (a[1].y + a[1].h))[0];
    L.root = pick ? put(L.root, id, pick[0], "bottom") : put(L.root, id, "*", side);
  }
  const onSide = (id, side) => { const r = RECTS[id], g = gap(); return !!r && (side === "left" ? r.x <= g + 1 : r.x + r.w >= tiles.clientWidth - g - 1); };
  function moveSide(id, side) { toSide(id, side); changed(); }

  // ---------- placing everything ----------
  let RECTS = {}, SPLITS = [];
  const gap = () => parseFloat(getComputedStyle(root).getPropertyValue("--gap")) || 6;
  const narrow = () => tiles.clientWidth < 600;
  function drawn(id) {
    if (id === "main") return true;
    if (isZen() || narrow()) return false;
    if (id === "app") return !$("#appview").hidden;
    return usable(id);
  }
  const shows = (n) => (typeof n === "string" ? drawn(n) : n.k.some(shows));
  const headH = (id) => (($(".p-head", leafEl(id))?.offsetHeight) || 38) + 2;
  const folded = (id) => !!PANELS[id] && L.collapsed.includes(id);
  const MINW = { main: 320, app: 240 };
  function minOf(n, horiz) {
    if (typeof n === "string") return horiz ? MINW[n] || 160 : folded(n) ? headH(n) : 64;
    const kids = n.k.filter(shows);
    if ((n.d === "r") === horiz) return kids.reduce((a, c) => a + minOf(c, horiz), 0) + gap() * Math.max(0, kids.length - 1);
    return Math.max(0, ...kids.map((c) => minOf(c, horiz)));
  }
  function solve(n, x, y, w, h, out, splits) {
    if (typeof n === "string") { out[n] = { x, y, w, h: folded(n) ? Math.min(h, headH(n)) : h }; return; }
    const kids = [];
    n.k.forEach((c, i) => { if (shows(c)) kids.push(i); });
    if (!kids.length) return;
    const horiz = n.d === "r", g = gap();
    // A hidden child's share goes to the shown child that holds the chat.
    const eff = kids.map((i) => n.s[i]);
    const hidden = n.k.map((_, i) => i).filter((i) => !kids.includes(i));
    const mi = kids.findIndex((i) => holds(n.k[i], "main"));
    if (mi >= 0) for (const i of hidden) eff[mi] += n.s[i];
    // Folded panels in a stack keep only their title.
    const fixed = kids.map((i) => (!horiz && folded(n.k[i]) ? headH(n.k[i]) : null));
    const full = horiz ? w : h;
    const room = Math.max(0, full - g * (kids.length - 1) - fixed.reduce((a, v) => a + (v || 0), 0));
    // Share the room by weight, but nothing gets less than its smallest useful size (the chat
    // stays readable on a small screen; its neighbours give way first).
    const mins = kids.map((i, j) => (fixed[j] != null ? 0 : minOf(n.k[i], horiz)));
    const sizes = kids.map((_, j) => fixed[j]);
    let left = room, free = kids.map((_, j) => j).filter((j) => fixed[j] == null);
    for (let pass = 0; pass < kids.length && free.length; pass++) {
      const wsum = free.reduce((a, j) => a + eff[j], 0) || 1;
      const low = free.filter((j) => left * eff[j] / wsum < mins[j]);
      if (!low.length) break;
      for (const j of low) { sizes[j] = mins[j]; left -= mins[j]; }
      free = free.filter((j) => !low.includes(j));
    }
    if (left < 0) {
      // Not even the smallest sizes fit: shrink everything evenly.
      const msum = mins.reduce((a, v) => a + v, 0) || 1;
      kids.forEach((_, j) => { if (fixed[j] == null) sizes[j] = Math.round(room * mins[j] / msum); });
    } else {
      const wsum = free.reduce((a, j) => a + eff[j], 0) || 1;
      for (const j of free) sizes[j] = Math.round(left * eff[j] / wsum);
      for (const j of kids.keys()) if (fixed[j] == null && free.indexOf(j) < 0) sizes[j] = Math.round(sizes[j]);
    }
    // Rounding leftovers go to the last child that is not folded.
    let lastFlex = -1;
    fixed.forEach((v, j) => { if (v == null) lastFlex = j; });
    if (lastFlex >= 0) sizes[lastFlex] = Math.max(0, sizes[lastFlex] + full - g * (kids.length - 1) - sizes.reduce((a, v) => a + v, 0));
    let pos = horiz ? x : y;
    kids.forEach((i, j) => {
      solve(n.k[i], horiz ? pos : x, horiz ? y : pos, horiz ? sizes[j] : w, horiz ? h : sizes[j], out, splits);
      pos += sizes[j];
      if (j < kids.length - 1) {
        splits.push({ n, a: i, b: kids[j + 1], horiz, size: sizes[j], sb: sizes[j + 1],
          ga: [i, ...(j === mi ? hidden : [])], gb: [kids[j + 1], ...(j + 1 === mi ? hidden : [])],
          off: fixed[j] != null || fixed[j + 1] != null,
          x: horiz ? pos : x, y: horiz ? y : pos, w: horiz ? g : w, h: horiz ? h : g });
      }
      pos += g;
    });
  }
  const zOf = (id) => L.z.indexOf(id);
  function layout() {
    const W = tiles.clientWidth, H = tiles.clientHeight, g = gap();
    const out = {}, splits = [];
    if (W > 0 && H > 0) {
      if (isZen() || narrow()) {
        const w = Math.min(1040, W - 2 * g);
        out.main = { x: Math.round((W - w) / 2), y: g, w, h: H - 2 * g };
      } else {
        solve(L.root, g, g, W - 2 * g, H - 2 * g, out, splits);
        if (L.float) {
          for (const id of Object.keys(out)) {
            const f = L.fl[id];
            if (!f) {
              // Newly shown (a panel, the program, or a layout picked while floating): it starts
              // where it would snap, on top of the others, and keeps that spot from now on.
              const r = out[id];
              L.fl[id] = [r.x / W, r.y / H, r.w / W, r.h / H].map((v) => Math.round(v * 10000) / 10000);
              raise(id, true);
            } else out[id] ={ x: Math.round(f[0] * W), y: Math.round(f[1] * H), w: Math.max(120, Math.round(f[2] * W)), h: Math.max(40, Math.round(f[3] * H)) };
            if (folded(id)) out[id].h = headH(id);
          }
        }
      }
    }
    RECTS = out;
    SPLITS = L.float ? [] : splits;
    document.body.classList.toggle("floating", !!L.float && !isZen() && !narrow());
    for (const id of LEAVES) {
      const el = leafEl(id), r = out[id];
      el.classList.toggle("t-off", !r);
      if (!r) continue;
      const st = el.style;
      st.left = `${r.x}px`; st.top = `${r.y}px`; st.width = `${r.w}px`; st.height = `${r.h}px`;
      st.zIndex = L.float ? String(2 + Math.max(0, zOf(id) + 1)) : "";
    }
    paintSplits();
    // Free-floating: the program (its own window, always on top) only shows while nothing above it overlaps it.
    let covered = false;
    const a = out.app;
    if (L.float && a) {
      covered = Object.entries(out).some(([k, r]) => k !== "app" && zOf(k) > zOf("app")
        && r.x < a.x + a.w && r.x + r.w > a.x && r.y < a.y + a.h && r.y + r.h > a.y);
    }
    $("#appview").toggleAttribute("data-covered", covered);
    window.dispatchEvent(new Event("brain:layout"));
  }

  // ---------- the lines between panels ----------
  const splitEls = [];
  function paintSplits() {
    let i = 0;
    for (const sp of SPLITS) {
      const el = splitEls[i] || (splitEls[i] = makeSplit());
      el.hidden = false;
      el._sp = sp;
      el.className = `split ${sp.horiz ? "v" : "h"}${sp.off ? " off" : ""}`;
      el.setAttribute("aria-orientation", sp.horiz ? "vertical" : "horizontal");
      el.setAttribute("aria-label", sp.horiz ? "Resize the panels on the left and right" : "Resize the panels above and below");
      Object.assign(el.style, { left: `${sp.x}px`, top: `${sp.y}px`, width: `${sp.w}px`, height: `${sp.h}px` });
      i++;
    }
    for (; i < splitEls.length; i++) splitEls[i].hidden = true;
  }
  // The mouse reports moves faster than the screen draws: lay out at most once per frame.
  // flush() applies the last move right away (on let go).
  function perFrame(fn) {
    let raf = 0, last = null;
    const run = () => { raf = 0; if (last) { const ev = last; last = null; fn(ev); } };
    const f = (ev) => { last = ev; if (!raf) raf = requestAnimationFrame(run); };
    f.flush = () => { if (raf) cancelAnimationFrame(raf); run(); };
    return f;
  }
  function makeSplit() {
    const el = h("div", { class: "split", role: "separator", tabindex: "0" });
    el.addEventListener("pointerdown", (e) => {
      const sp = el._sp;
      if (e.button !== 0 || !sp || sp.off) return;
      e.preventDefault();
      const set = resizer(sp), p0 = sp.horiz ? e.clientX : e.clientY;
      el.setPointerCapture(e.pointerId);
      el.classList.add("drag");
      document.body.classList.add("dragging");
      const mv = perFrame((ev) => set((sp.horiz ? ev.clientX : ev.clientY) - p0));
      const up = () => {
        el.removeEventListener("pointermove", mv);
        mv.flush();
        el.classList.remove("drag");
        document.body.classList.remove("dragging");
        changed();
      };
      el.addEventListener("pointermove", mv);
      el.addEventListener("pointerup", up, { once: true });
      el.addEventListener("pointercancel", up, { once: true });
    });
    el.addEventListener("keydown", (e) => {
      const sp = el._sp;
      if (!sp || sp.off) return;
      const keys = sp.horiz ? { ArrowLeft: -24, ArrowRight: 24 } : { ArrowUp: -24, ArrowDown: 24 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      resizer(sp)(keys[e.key]);
      changed();
      el.focus();
    });
    tiles.append(el);
    return el;
  }
  // Moving a line by d pixels: the two sides (and the program's hidden share, with the chat) scale.
  function resizer(sp) {
    const s0 = [...sp.n.s], total = sp.size + sp.sb;
    const minA = Math.min(minOf(sp.n.k[sp.a], sp.horiz), total / 2), minB = Math.min(minOf(sp.n.k[sp.b], sp.horiz), total / 2);
    return (d) => {
      if (sp.size <= 0 || sp.sb <= 0) return;
      const pa = Math.max(minA, Math.min(total - minB, sp.size + d));
      const fa = pa / sp.size, fb = (total - pa) / sp.sb;
      sp.n.s = s0.map((w, i) => r3(w * (sp.ga.includes(i) ? fa : sp.gb.includes(i) ? fb : 1)));
      layout();
    };
  }

  // ---------- moving a panel: drag it by its title ----------
  const hint = h("div", { id: "drop-hint", hidden: true });
  const ghost = h("div", { id: "move-ghost", hidden: true });
  tiles.append(hint);
  document.body.append(ghost);
  function dropAt(px, py, id) {
    const W = tiles.clientWidth, H = tiles.clientHeight, E = 22;
    if (px < E) return { target: "*", side: "left" };
    if (px > W - E) return { target: "*", side: "right" };
    if (py < E) return { target: "*", side: "top" };
    if (py > H - E) return { target: "*", side: "bottom" };
    for (const [k, r] of Object.entries(RECTS)) {
      if (k === id || px < r.x || px > r.x + r.w || py < r.y || py > r.y + r.h) continue;
      const u = (px - r.x) / r.w, v = (py - r.y) / r.h;
      const dist = { left: u, right: 1 - u, top: v, bottom: 1 - v };
      const side = SIDES.slice().sort((p, q) => dist[p] - dist[q])[0];
      return dist[side] > 0.3 ? { target: k, side: "swap" } : { target: k, side };
    }
    return null;
  }
  function paintHint(d) {
    hint.hidden = !d;
    if (!d) return;
    const W = tiles.clientWidth, H = tiles.clientHeight, g = gap();
    let r;
    if (d.target === "*") {
      const sw = Math.round(W * 0.22), sh = Math.round(H * 0.3);
      r = { left: { x: g, y: g, w: sw, h: H - 2 * g }, right: { x: W - g - sw, y: g, w: sw, h: H - 2 * g }, top: { x: g, y: g, w: W - 2 * g, h: sh }, bottom: { x: g, y: H - g - sh, w: W - 2 * g, h: sh } }[d.side];
    } else {
      const t = RECTS[d.target];
      r = d.side === "swap" ? t : { left: { ...t, w: t.w / 2 }, right: { ...t, x: t.x + t.w / 2, w: t.w / 2 }, top: { ...t, h: t.h / 2 }, bottom: { ...t, y: t.y + t.h / 2, h: t.h / 2 } }[d.side];
    }
    Object.assign(hint.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    hint.textContent = d.side === "swap" ? `Swap with ${leafName(d.target)}` : "";
  }
  function dropLeaf(id, d) {
    if (!d || d.target === id) return;
    if (d.side === "swap") L.root = swapIn(L.root, id, d.target);
    else L.root = put(cut(L.root, id), id, d.target, d.side);
    changed();
  }
  function grab(e, id) {
    if (e.button !== 0 || e.target.closest("button, input, textarea, select, a, label, [contenteditable], .rz")) return;
    if ($(".panel.max") || isZen() || narrow()) return;
    const x0 = e.clientX, y0 = e.clientY, r0 = { ...RECTS[id] };
    if (L.float) raise(id);
    let on = false, drop = null;
    const box = tiles.getBoundingClientRect();
    const mv = perFrame((ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      if (!on) {
        if (Math.hypot(dx, dy) < 5) return;
        on = true;
        getSelection()?.removeAllRanges();
        document.body.classList.add("dragging", "moving");
        leafEl(id).classList.add("lifted");
        if (!L.float) { ghost.textContent = `Moving ${leafName(id)}`; ghost.hidden = false; }
      }
      if (L.float) { floatTo(id, { ...r0, x: r0.x + dx, y: r0.y + dy }, "move"); return; }
      drop = dropAt(ev.clientX - box.left, ev.clientY - box.top, id);
      paintHint(drop);
      Object.assign(ghost.style, { left: `${ev.clientX + 14}px`, top: `${ev.clientY + 12}px` });
    });
    const end = (keep) => {
      document.removeEventListener("pointermove", mv);
      mv.flush();
      document.removeEventListener("pointerup", upH);
      document.removeEventListener("pointercancel", cancelH);
      document.removeEventListener("keydown", keyH, true);
      if (!on) return;
      document.body.classList.remove("dragging", "moving");
      leafEl(id).classList.remove("lifted");
      hint.hidden = true; ghost.hidden = true;
      if (L.float) { if (!keep) floatTo(id, r0, "move"); save(); return; }
      if (keep) dropLeaf(id, drop); else layout();
    };
    const upH = () => end(true), cancelH = () => end(false);
    const keyH = (ev) => { if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); end(false); } };
    document.addEventListener("pointermove", mv);
    document.addEventListener("pointerup", upH);
    document.addEventListener("pointercancel", cancelH);
    document.addEventListener("keydown", keyH, true);
  }

  // ---------- free-floating panels ----------
  function raise(id, quiet) {
    if (L.z[L.z.length - 1] === id) return;
    L.z = [...L.z.filter((x) => x !== id), id];
    if (!quiet) { layout(); save(); }
  }
  tiles.addEventListener("pointerdown", (e) => {
    const leaf = L.float && e.target.closest(".leaf");
    if (leaf && !e.target.closest(".rz, .grab")) raise(leaf.dataset.leaf);
  }, true);
  // Edges within 8 px of another panel's edge (or the work area's) line up with it.
  function snapEdges(id, r, mode, dir = "") {
    const W = tiles.clientWidth, H = tiles.clientHeight, g = gap(), S = 8;
    const xs = [g, W - g], ys = [g, H - g];
    for (const [k, o] of Object.entries(RECTS)) if (k !== id) { xs.push(o.x - g, o.x, o.x + o.w, o.x + o.w + g); ys.push(o.y - g, o.y, o.y + o.h, o.y + o.h + g); }
    const near = (v, list) => { let best = null; for (const c of list) if (Math.abs(c - v) <= S && (best == null || Math.abs(c - v) < Math.abs(best - v))) best = c; return best; };
    if (mode === "move") {
      const l = near(r.x, xs), rr = near(r.x + r.w, xs), t = near(r.y, ys), b = near(r.y + r.h, ys);
      if (l != null) r.x = l; else if (rr != null) r.x = rr - r.w;
      if (t != null) r.y = t; else if (b != null) r.y = b - r.h;
    } else {
      if (dir.includes("w")) { const l = near(r.x, xs); if (l != null) { r.w += r.x - l; r.x = l; } }
      if (dir.includes("e")) { const rr = near(r.x + r.w, xs); if (rr != null) r.w = rr - r.x; }
      if (dir.includes("n")) { const t = near(r.y, ys); if (t != null) { r.h += r.y - t; r.y = t; } }
      if (dir.includes("s")) { const b = near(r.y + r.h, ys); if (b != null) r.h = b - r.y; }
    }
    return r;
  }
  function floatTo(id, r, mode, dir) {
    const W = tiles.clientWidth, H = tiles.clientHeight;
    r = snapEdges(id, { ...r }, mode, dir);
    // Keep a piece of it on screen so it can always be grabbed again.
    r.x = Math.max(60 - r.w, Math.min(W - 60, r.x));
    r.y = Math.max(0, Math.min(H - 40, r.y));
    L.fl[id] = [r.x / W, r.y / H, r.w / W, r.h / H].map((v) => Math.round(v * 10000) / 10000);
    layout();
  }
  function resizeFloat(e, id, dir) {
    if (e.button !== 0 || !L.float) return;
    e.preventDefault(); e.stopPropagation();
    raise(id);
    const x0 = e.clientX, y0 = e.clientY, r0 = { ...RECTS[id] }, el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add("dragging");
    const minW = MINW[id] || 140, minH = folded(id) ? headH(id) : 80;
    const mv = perFrame((ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0, r = { ...r0 };
      if (dir.includes("e")) r.w = Math.max(minW, r0.w + dx);
      if (dir.includes("s")) r.h = Math.max(minH, r0.h + dy);
      if (dir.includes("w")) { r.w = Math.max(minW, r0.w - dx); r.x = r0.x + r0.w - r.w; }
      if (dir.includes("n")) { r.h = Math.max(minH, r0.h - dy); r.y = r0.y + r0.h - r.h; }
      floatTo(id, r, "size", dir);
    });
    const up = () => { el.removeEventListener("pointermove", mv); mv.flush(); document.body.classList.remove("dragging"); save(); };
    el.addEventListener("pointermove", mv);
    el.addEventListener("pointerup", up, { once: true });
    el.addEventListener("pointercancel", up, { once: true });
  }
  function setFloat(on) {
    on = !!on;
    if (on === !!L.float) return;
    if (on) {
      // Start from where everything is now.
      const W = tiles.clientWidth || 1, H = tiles.clientHeight || 1;
      L.fl = {};
      for (const [id, r] of Object.entries(RECTS)) L.fl[id] = [r.x / W, r.y / H, r.w / W, r.h / H].map((v) => Math.round(v * 10000) / 10000);
    }
    L.float = on;
    render();
    save();
    toast(on ? "Free-floating panels: drag a title to move, drag an edge or corner to resize." : "Panels snap into place again.", "ok");
  }

  // ---------- render ----------
  function render() {
    for (const id of IDS) {
      const shown = isShown(id);
      panelEl(id).classList.toggle("collapsed", L.collapsed.includes(id));
      const b = railBtns[id];
      b.hidden = !usable(id);
      b.classList.toggle("on", shown);
      b.setAttribute("aria-pressed", String(shown));
    }
    for (const b of $$("#presets [data-preset]")) b.setAttribute("aria-pressed", String(b.dataset.preset === L.preset));
    $('#presets [data-preset="mine"]').hidden = !L.mine;
    const fl = $("#set-float");
    if (fl) fl.checked = !!L.float;
    layout();
    if (isShown("discord")) discordWanted();
    musicSoon();
    if (isShown("usage")) paintUsagePanel();
  }
  new ResizeObserver(() => layout()).observe(tiles);
  new MutationObserver(() => layout()).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  new MutationObserver(() => layout()).observe($("#appview"), { attributes: true, attributeFilter: ["hidden"] });
  new MutationObserver(() => layout()).observe(root, { attributes: true, attributeFilter: ["data-density"] });
  $("#set-float")?.addEventListener("change", (e) => setFloat(e.currentTarget.checked));

  // ---------- menus ----------
  const menu = $("#menu");
  let menuFrom = null;
  function closeMenu() {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
    const f = menuFrom; menuFrom = null;
    f?.focus?.();
  }
  function openMenu(anchor, items) {
    closeMenu();
    menuFrom = anchor;
    for (const it of items) {
      if (it === "-") { menu.append(h("hr")); continue; }
      if (it.header) { menu.append(h("div", { class: "menu-h", text: it.header })); continue; }
      const b = h("button", { type: "button", role: it.checked == null ? "menuitem" : "menuitemcheckbox", disabled: !!it.disabled },
        it.swatch ? h("span", { class: `menu-sw sw-${it.swatch}` }) : it.icon ? icon(it.icon) : null, h("span", { text: it.label }));
      if (it.value) b.dataset.value = it.value;
      if (it.checked != null) b.setAttribute("aria-checked", String(!!it.checked));
      b.addEventListener("click", () => { closeMenu(); it.run(); });
      menu.append(b);
    }
    menu.hidden = false;
    const r = anchor.getBoundingClientRect(), m = menu.getBoundingClientRect();
    let x = r.right - m.width, y = r.bottom + 4;
    if (anchor.closest("#rail")) { x = r.right + 6; y = Math.min(r.top, window.innerHeight - m.height - 8); }
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - m.width - 8))}px`;
    menu.style.top = `${Math.max(8, y + m.height > window.innerHeight - 8 ? r.top - m.height - 4 : y)}px`;
    $("button:not(:disabled)", menu)?.focus();
  }
  menu.addEventListener("keydown", (e) => {
    const btns = $$("button:not(:disabled)", menu), i = btns.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
    else if (e.key === "Tab") closeMenu();
  });
  document.addEventListener("pointerdown", (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); }, true);
  window.addEventListener("resize", closeMenu);
  window.addEventListener("blur", closeMenu);

  // The leaf right above or below this one on screen (overlapping it sideways).
  function neighbour(id, dir) {
    const r = RECTS[id];
    if (!r) return null;
    let best = null, bestD = Infinity;
    for (const [k, o] of Object.entries(RECTS)) {
      if (k === id || Math.min(r.x + r.w, o.x + o.w) - Math.max(r.x, o.x) < 20) continue;
      const d = dir < 0 ? r.y - (o.y + o.h) : o.y - (r.y + r.h);
      if (d >= -2 && d < bestD) { best = k; bestD = d; }
    }
    return best;
  }
  function panelMenu(id, anchor) {
    const coll = L.collapsed.includes(id), up = neighbour(id, -1), down = neighbour(id, 1);
    const fl = !!L.float;
    openMenu(anchor, [
      { label: coll ? "Expand" : "Collapse to its title", icon: coll ? "down" : "up", run: () => toggleCollapse(id) },
      { label: "Make bigger (Esc to go back)", icon: "max", run: () => B.toggleMax(panelEl(id), true) },
      "-",
      { label: "Move up", icon: "up", disabled: fl || !up, run: () => move(id, -1) },
      { label: "Move down", icon: "down", disabled: fl || !down, run: () => move(id, 1) },
      { label: "Move to the left side", icon: "left", disabled: fl || onSide(id, "left"), run: () => moveSide(id, "left") },
      { label: "Move to the right side", icon: "right", disabled: fl || onSide(id, "right"), run: () => moveSide(id, "right") },
      "-",
      { label: "Hide this panel", icon: "x", run: () => hide(id) },
    ]);
  }
  // Quick theme picker in the top bar.
  $("#btn-theme").addEventListener("click", (e) => {
    const now = B.S.settings?.theme;
    openMenu(e.currentTarget, [{ header: "Theme" }, ...B.THEMES.map((t) => ({
      label: B.THEME_NAMES[t] || t, swatch: t, value: t, checked: now === t, run: () => B.saveSetting({ theme: t }),
    })), "-", { label: "More in Settings…", icon: "gear", run: B.openSettings }]);
  });
  $("#btn-layout").addEventListener("click", (e) => {
    const items = [{ header: "Layouts" }];
    for (const [k, name] of Object.entries(PRESET_NAMES)) {
      if (k === "mine" && !L.mine) continue;
      items.push({ label: name, checked: L.preset === k, run: () => preset(k) });
    }
    items.push({ label: "Save this layout as Mine", icon: "bookmark", run: saveMine });
    items.push({ label: "Free-floating panels", checked: !!L.float, run: () => setFloat(!L.float) });
    items.push("-", { header: "Panels" });
    for (const id of IDS) if (usable(id)) items.push({ label: PANELS[id].label, checked: isShown(id), run: () => (isShown(id) ? hide(id) : show(id)) });
    openMenu(e.currentTarget, items);
  });

  function preset(name) {
    const next = fromPreset(name, L);
    if (!next) { toast("Save a layout as Mine first (Layout menu)."); return; }
    if (isZen()) B.setZen(false);
    const max = $(".panel.max");
    if (max) B.toggleMax(max, false);
    L = next;
    render();
    save();
  }
  function saveMine() {
    L.mine = { root: clone(L.root), collapsed: [...L.collapsed], fl: clone(L.fl || {}) };
    L.preset = "mine";
    render();
    save();
    toast("Saved as your own layout. Press Alt+5 to bring it back.", "ok");
  }
  for (const b of $$("#presets [data-preset]")) b.addEventListener("click", () => preset(b.dataset.preset));

  // ---------- work modes ----------
  const MODES = {
    auto: "Claude decides when to ask Gemini",
    solo: "Claude alone – fastest, uses the least of your limits",
    team: "Claude and Gemini both answer, Claude combines them",
    debate: "Gemini argues the other side, Claude gives the verdict",
    extreme: "Plan, ask, draft, get it checked, fix – slowest and most careful",
  };
  let mode = Object.hasOwn(MODES, store.get("mode", "auto")) ? store.get("mode", "auto") : "auto";
  function paintMode() {
    for (const b of $$("#modes [data-mode]")) {
      const on = b.dataset.mode === mode;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    $("#mode-hint").textContent = MODES[mode];
  }
  function setMode(m, quiet) {
    if (!Object.hasOwn(MODES, m)) return;
    mode = m;
    store.set("mode", m);
    paintMode();
    if (!quiet) toast(`Work mode: ${m[0].toUpperCase()}${m.slice(1)}. ${MODES[m]}.`, "ok");
  }
  for (const b of $$("#modes [data-mode]")) b.addEventListener("click", () => setMode(b.dataset.mode, true));
  $("#modes").addEventListener("keydown", (e) => {
    const keys = Object.keys(MODES), i = keys.indexOf(mode);
    let j = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % keys.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i - 1 + keys.length) % keys.length;
    if (j < 0) return;
    e.preventDefault();
    setMode(keys[j], true);
    $(`#modes [data-mode="${keys[j]}"]`).focus();
  });

  // ---------- numbers ----------
  const fmtN = (n) => {
    n = Number(n) || 0;
    if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
  };
  const fmtUsd = (c) => (!c ? "–" : c < 0.01 ? "<$0.01" : `$${c.toFixed(c < 10 ? 2 : 0)}`);
  const pctOf = (v) => (v == null ? null : Math.max(0, Math.min(100, v <= 1 ? v * 100 : v)));
  function resetText(sec) {
    if (!sec) return "";
    const d = new Date(sec * 1000), same = d.toDateString() === new Date().toDateString();
    return `Resets ${same ? "at " : ""}${d.toLocaleString([], same ? { hour: "2-digit", minute: "2-digit", hour12: !B.S.settings?.clock24 } : { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: !B.S.settings?.clock24 })}`;
  }

  // ---------- usage panel ----------
  let stats = null, statsTimer = 0, statsBusy = false;
  async function loadStats() {
    if (statsBusy) return;
    statsBusy = true;
    try { stats = await api("/api/stats"); } catch { /* keep the last numbers */ }
    statsBusy = false;
    paintUsagePanel();
    paintStatusBar();
  }
  function statsSoon(ms = 1200) { clearTimeout(statsTimer); statsTimer = setTimeout(loadStats, ms); }
  const warned = {};
  function paintMeters() {
    const u = B.S.usage || {};
    for (const [key, id, label] of [["five_hour", "5h", "5-hour limit"], ["seven_day", "7d", "weekly limit"]]) {
      const pct = pctOf(u[key]);
      const num = $(`#um-${id}`), bar = $(`#um-${id}-bar`), note = $(`#um-${id}-note`);
      if (pct == null) { num.textContent = "–"; bar.style.width = "0"; bar.className = ""; note.textContent = id === "5h" ? "Shown after the first task" : ""; continue; }
      num.textContent = `${Math.round(pct)}% used`;
      bar.style.width = `${pct}%`;
      bar.className = pct >= 90 ? "bad" : pct >= 70 ? "warn" : "";
      note.textContent = resetText(u[`${key}_resets`]);
      const level = pct >= 90 ? 90 : pct >= 75 ? 75 : 0;
      if (level && (warned[key] || 0) < level && !B.S.replaying) {
        warned[key] = level;
        toast(`You have used ${Math.round(pct)}% of your Claude ${label}. ${resetText(u[`${key}_resets`])}.`, level >= 90 ? "err" : "", 8000);
      }
    }
  }
  function row(tbody, key, cells, titles = []) {
    const tr = $(`tr[data-k="${key}"]`, tbody);
    $$("td", tr).forEach((td, i) => { td.textContent = cells[i]; td.title = titles[i] || ""; });
  }
  function paintUsagePanel() {
    paintMeters();
    if (!stats) return;
    const c = stats.claude, g = stats.geminiUse;
    const ct = $("#u-claude tbody");
    for (const k of ["session", "today", "all"]) {
      const b = c[k];
      row(ct, k, [fmtN(b.tasks), fmtN(b.in), fmtN(b.out), fmtUsd(b.cost)], ["", `${(b.in || 0).toLocaleString()} new tokens, plus ${(b.cached || 0).toLocaleString()} read from cache`, `${(b.out || 0).toLocaleString()} tokens`, "What this would cost at pay-per-use API prices. Your subscription covers it."]);
    }
    const l = c.last;
    $("#u-last").textContent = l
      ? `Last task: ${B.dur(Math.round(l.seconds || 0))} · ${fmtN(l.in)} in · ${fmtN(l.out)} out · ${l.turns || 0} steps · ${fmtUsd(l.cost)} at API prices (covered by your plan)`
      : "Token numbers appear after a task finishes.";
    const gt = $("#u-gemini tbody");
    for (const k of ["today", "all"]) {
      const b = g[k];
      row(gt, k, [fmtN(b.calls), fmtN(b.failed), b.tokens ? fmtN(b.tokens) : "–", fmtN(b.pictures)], ["", "", b.tokens ? `${b.tokens.toLocaleString()} tokens` : "Gemini did not report tokens", ""]);
    }
    const q = g.lastQuota;
    $("#u-quota").textContent = q
      ? `Gemini's ${q.what || "picture"} limit was reached ${new Date(q.t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: !B.S.settings?.clock24 })}${q.resets ? ` (it said: resets in ${q.resets})` : ""}.`
      : "Google does not show Gemini's limits to apps, so these are counted on this PC.";
    paintChatGPT();
    const v = stats.videoUse || { all: 0, today: 0, seconds: 0 };
    $("#u-video").hidden = !v.all;
    $("#u-video").textContent = `Videos (Google Veo): ${v.today} today · ${v.all} all time · ${v.seconds} seconds of video in total. Google charges for these on your own key.`;
    paintChart();
  }
  // ChatGPT: requests and tokens counted on this PC, plus the plan limits ChatGPT itself last reported.
  const winName = (mins, fallback) => (mins === 300 ? "5-hour limit" : mins === 10080 ? "Weekly limit"
    : !mins ? fallback : mins < 1440 ? `${Math.round(mins / 60)}-hour limit` : `${Math.round(mins / 1440)}-day limit`);
  function chatgptWindows() {
    const l = stats?.chatgptUse?.limits;
    const live = (w) => (w && typeof w.pct === "number" ? { ...w, over: !!w.resets && w.resets * 1000 < Date.now() } : null);
    return { t: l?.t || 0, short: live(l?.short), long: live(l?.long) };
  }
  function paintChatGPT() {
    const c = stats.chatgptUse;
    if (!c) return;
    const tb = $("#u-chatgpt tbody");
    for (const k of ["today", "all"]) {
      const b = c[k];
      row(tb, k, [fmtN(b.calls), fmtN(b.failed), b.in ? fmtN(b.in) : "–", b.out ? fmtN(b.out) : "–"],
        ["", "", b.in ? `${b.in.toLocaleString()} tokens sent, ${(b.cached || 0).toLocaleString()} of them read from cache` : "", b.out ? `${b.out.toLocaleString()} tokens` : ""]);
    }
    const w = chatgptWindows();
    for (const [key, fallback] of [["short", "5-hour limit"], ["long", "Weekly limit"]]) {
      const x = w[key], num = $(`#uc-${key}`), bar = $(`#uc-${key}-bar`), note = $(`#uc-${key}-note`);
      $(`#uc-${key}-name`).textContent = winName(x?.mins, fallback);
      if (!x || x.over) {
        num.textContent = "–"; bar.style.width = "0"; bar.className = "";
        note.textContent = x?.over ? "This limit has started again since ChatGPT was last asked" : key === "short" ? "Shown after ChatGPT is asked once" : "";
        continue;
      }
      num.textContent = `${Math.round(x.pct)}% used`;
      bar.style.width = `${x.pct}%`;
      bar.className = x.pct >= 90 ? "bad" : x.pct >= 70 ? "warn" : "";
      note.textContent = resetText(x.resets);
      if (x.pct >= 90 && !warned[`chatgpt-${key}`] && !B.S.replaying) {
        warned[`chatgpt-${key}`] = 1;
        toast(`You have used ${Math.round(x.pct)}% of your ChatGPT ${winName(x.mins, fallback).toLowerCase()}. ${resetText(x.resets)}.`, "err", 8000);
      }
    }
    const when = w.t ? new Date(w.t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: !B.S.settings?.clock24 }) : "";
    $("#u-chatgpt-note").textContent = B.S.settings && !B.S.settings.chatgptEnabled && !c.all.calls
      ? "ChatGPT is switched off. You can turn it on in Settings."
      : w.short || w.long
        ? `Limits as ChatGPT last reported them (${when}). They update each time ChatGPT is asked. Requests and tokens are counted on this PC.`
        : "Requests and tokens are counted on this PC. The limit bars appear after ChatGPT is asked once.";
  }
  function paintChart() {
    const box = $("#u-chart"), days = stats?.days || [];
    const max = Math.max(1, ...days.map((d) => d.tasks));
    const cols = days.map((d) => {
      const col = h("div", { class: "col", "data-day": d.day, "data-tasks": String(d.tasks), "data-gemini": String(d.gemini), "data-chatgpt": String(d.chatgpt || 0) });
      if (d.tasks) { const bar = h("i"); bar.style.height = `${Math.max(4, (d.tasks / max) * 100)}%`; col.append(bar); }
      return col;
    });
    box.replaceChildren(...cols);
    let axis = box.nextElementSibling;
    if (!axis || !axis.classList.contains("chart-axis")) { axis = h("div", { class: "chart-axis" }); box.after(axis); }
    const first = days[0] ? new Date(`${days[0].day}T12:00`).toLocaleDateString([], { day: "numeric", month: "short" }) : "";
    axis.replaceChildren(h("span", { text: first }), h("span", { text: `Most: ${max === 1 && !days.some((d) => d.tasks) ? 0 : max}` }), h("span", { text: "Today" }));
    const total = days.reduce((a, d) => a + d.tasks, 0);
    box.setAttribute("aria-label", `Tasks per day for the last 14 days: ${total} in total, most in one day ${days.length ? Math.max(...days.map((d) => d.tasks)) : 0}.`);
  }
  const tip = $("#u-tip");
  tip.remove();
  document.body.append(tip);
  $("#u-chart").addEventListener("pointermove", (e) => {
    const col = e.target.closest(".col");
    if (!col) { tip.hidden = true; return; }
    const d = new Date(`${col.dataset.day}T12:00`);
    const t = Number(col.dataset.tasks), gm = Number(col.dataset.gemini), cg = Number(col.dataset.chatgpt) || 0;
    tip.replaceChildren(h("div", { text: d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) }),
      h("div", {}, h("b", { text: String(t) }), ` task${t === 1 ? "" : "s"} · `, h("b", { text: String(gm) }), ` Gemini request${gm === 1 ? "" : "s"}`,
        ...(cg ? [" · ", h("b", { text: String(cg) }), ` ChatGPT request${cg === 1 ? "" : "s"}`] : [])));
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = `${Math.max(8, Math.min(e.clientX - r.width / 2, window.innerWidth - r.width - 8))}px`;
    tip.style.top = `${e.clientY - r.height - 12}px`;
  });
  $("#u-chart").addEventListener("pointerleave", () => { tip.hidden = true; });
  $("#usage-refresh").addEventListener("click", loadStats);

  // ---------- status bar ----------
  function paintStatusBar() {
    const s = B.S.settings;
    const busy = !!B.S.busy;
    $("#sb-dot").className = `dot ${busy ? "busy" : B.S.status?.claude?.ok === false ? "bad" : "ok"}`;
    $("#sb-phase").textContent = $("#phase-label").textContent || "Ready";
    if (s) {
      const model = { auto: "Claude default", fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" }[s.brainModel] || s.brainModel;
      $("#sb-model").textContent = `${model} · effort ${s.effort === "auto" ? "auto" : s.effort}`;
    }
    if (stats) {
      const t = stats.geminiUse.today;
      $("#sb-gemini").textContent = `Gemini ${t.calls} today${t.pictures ? ` · ${t.pictures} pic` : ""}${stats.videoUse?.today ? ` · ${stats.videoUse.today} video` : ""}`;
      const c = stats.chatgptUse, wk = chatgptWindows().long;
      $("#sb-chatgpt").hidden = !c || !(s?.chatgptEnabled || c.today.calls);
      if (c) $("#sb-chatgpt").textContent = `ChatGPT ${c.today.calls} today${wk && !wk.over ? ` · week ${Math.round(wk.pct)}%` : ""}`;
    }
  }
  new MutationObserver(paintStatusBar).observe($("#phase-label"), { childList: true, characterData: true, subtree: true });
  $("#usage").addEventListener("click", () => show("usage"));
  $("#sb-gemini").addEventListener("click", () => show("usage"));
  $("#sb-chatgpt").addEventListener("click", () => show("usage"));
  $("#sb-brain").addEventListener("click", () => show("activity"));
  $("#sb-model").addEventListener("click", B.openSettings);
  $("#sb-track").addEventListener("click", () => show("music"));
  function tick() {
    const d = new Date(), h24 = B.S.settings?.clock24 !== false;
    $("#sb-clock").textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: !h24 });
    $("#sb-clock").title = d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }
  tick();
  setInterval(tick, 10_000);

  // ---------- music ----------
  let ms = null, msAt = 0, musicTimer = 0, artKey = "", seeking = false;
  const mmss = (s) => { s = Math.max(0, Math.round(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  function musicPos() { return ms?.playing ? Math.min(ms.duration || Infinity, (ms.position || 0) + (Date.now() - msAt) / 1000) : ms?.position || 0; }
  function setPlayIcon(btn, playing) {
    btn.replaceChildren(icon(playing ? "pause" : "play"));
    btn.title = playing ? "Pause" : "Play";
    btn.setAttribute("aria-label", btn.title);
  }
  function paintMusic() {
    const on = !!ms?.active;
    const can = (k) => on && !!ms.can?.[k];
    $("#music-title").textContent = on ? ms.title || "Unknown song" : "Nothing is playing";
    $("#music-artist").textContent = on ? [ms.artist, ms.album].filter(Boolean).join(" · ") || ms.app || "" : ms && ms.ok === false ? ms.error || "Music controls are not available." : "Open Spotify and start a song";
    $("#music-app").textContent = on ? ms.app || "" : "";
    for (const [id, k] of [["#music-prev", "prev"], ["#music-next", "next"], ["#music-toggle", "toggle"], ["#music-shuffle", "shuffle"], ["#music-repeat", "repeat"]]) $(id).disabled = !can(k);
    setPlayIcon($("#music-toggle"), on && ms.playing);
    $("#music-shuffle").setAttribute("aria-pressed", String(on && !!ms.shuffle));
    const rep = on ? ms.repeat : "None";
    $("#music-repeat").setAttribute("aria-pressed", String(rep && rep !== "None"));
    $("#music-repeat").title = rep === "Track" ? "Repeat: this song" : rep === "List" ? "Repeat: the list" : "Repeat: off";
    const seek = $("#music-seek");
    seek.disabled = !can("seek") || !(ms.duration > 0);
    if (!seeking) {
      seek.max = String(Math.max(1, Math.round(ms?.duration || 100)));
      seek.value = String(Math.round(musicPos()));
    }
    $("#music-pos").textContent = mmss(seeking ? Number(seek.value) : musicPos());
    $("#music-dur").textContent = mmss(on ? ms.duration : 0);
    // cover picture
    const key = on && ms.artKey ? ms.artKey : "";
    if (key !== artKey) {
      artKey = key;
      const box = $("#music-art");
      if (key) {
        const img = h("img", { alt: "", src: `/api/music/art?k=${encodeURIComponent(key)}` });
        img.addEventListener("error", () => box.replaceChildren(icon("music")));
        box.replaceChildren(img);
      } else box.replaceChildren(icon("music"));
    }
    // status bar
    $("#sb-music").hidden = !on;
    if (on) {
      setPlayIcon($("#sb-toggle"), ms.playing);
      $("#sb-track").textContent = [ms.title, ms.artist].filter(Boolean).join(" – ");
      $("#sb-track").title = `${ms.app || "Music"}: ${$("#sb-track").textContent} (click for the Music panel)`;
      $("#sb-prev").disabled = !can("prev");
      $("#sb-next").disabled = !can("next");
    }
  }
  async function loadMusic() {
    clearTimeout(musicTimer);
    musicTimer = 0;
    if (document.hidden || B.S.closing) return;
    try { ms = await api("/api/music"); msAt = Date.now(); } catch (err) { ms = { ok: false, error: err.message }; }
    paintMusic();
    // Poll quickly while the panel is open and something is playing, slowly otherwise.
    const delay = isShown("music") && ms?.active ? 2000 : ms?.active ? 5000 : 12_000;
    musicTimer = setTimeout(loadMusic, delay);
  }
  function musicSoon() { if (!musicTimer || isShown("music")) { clearTimeout(musicTimer); musicTimer = setTimeout(loadMusic, 50); } }
  setInterval(() => { if (ms?.active && ms.playing && !seeking) paintMusic(); }, 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) musicSoon(); });
  async function musicCmd(cmd, arg) {
    try {
      const r = await api("/api/music/cmd", { cmd, arg });
      if (r && r.ok === false) { toast(r.error || "The player did not accept that.", "err"); return; }
      ms = r; msAt = Date.now();
      paintMusic();
    } catch (err) { toast(err.message || "Music control failed.", "err"); }
  }
  $("#music-toggle").addEventListener("click", () => musicCmd("toggle"));
  $("#music-prev").addEventListener("click", () => musicCmd("prev"));
  $("#music-next").addEventListener("click", () => musicCmd("next"));
  $("#music-shuffle").addEventListener("click", () => musicCmd("shuffle"));
  $("#music-repeat").addEventListener("click", () => musicCmd("repeat"));
  $("#sb-toggle").addEventListener("click", () => musicCmd("toggle"));
  $("#sb-prev").addEventListener("click", () => musicCmd("prev"));
  $("#sb-next").addEventListener("click", () => musicCmd("next"));
  const seekEl = $("#music-seek");
  seekEl.addEventListener("input", () => { seeking = true; $("#music-pos").textContent = mmss(Number(seekEl.value)); });
  seekEl.addEventListener("change", async () => { await musicCmd("seek", Number(seekEl.value)); seeking = false; });
  seekEl.addEventListener("blur", () => { seeking = false; });
  $("#music-open").addEventListener("click", async () => { if (await tryApi("/api/open-app", { app: "spotify" })) toast("Opening Spotify…", "ok"); });
  $("#music-search").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#music-q").value.trim();
    if (!q) { $("#music-q").focus(); return; }
    if (await tryApi("/api/open-app", { app: "spotify", q })) { toast(`Searching Spotify for "${B.short(q, 40)}"…`, "ok"); $("#music-q").value = ""; }
  });

  // ---------- Discord (the app installed on this PC) ----------
  // AI Brain opens the real Discord app and, in the desktop window, can lay it out beside
  // AI Brain. It never shows Discord inside this page and never reads anything from it.
  const DC = { installed: true, running: false, beside: false, busy: false, timer: 0 };
  function paintDiscord() {
    const st = $("#discord-state");
    st.textContent = !DC.installed ? "Not found" : DC.running ? "Running" : "Not running";
    st.classList.toggle("on", DC.running);
    const chats = pinnedChats();
    $("#discord-note").hidden = DC.installed && chats.length > 0;
    $("#discord-note-title").textContent = DC.installed ? "Pin your chats here" : "Discord was not found";
    $("#discord-note-text").textContent = !DC.installed
      ? "The Discord app was not found on this PC. The buttons try Discord's link anyway; if nothing opens, install Discord from discord.com."
      : "Press + and paste a chat's link. A click on it opens that chat in your Discord app.";
    $("#discord-start").textContent = DC.running ? "Show the Discord app" : "Open the Discord app";
    $("#discord-beside").hidden = !shell || !DC.installed || DC.beside;
    $("#discord-back").hidden = !shell || !DC.beside;
    for (const b of ["#discord-start", "#discord-beside", "#discord-back"]) $(b).disabled = DC.busy;
    paintChats(chats);
  }

  // Pinned chats: a name you typed plus the two numbers from the chat's link. Nothing is read from Discord.
  function pinnedChats() { const c = B.S.settings?.discordChats; return Array.isArray(c) ? c : []; }
  function parseChatLink(text) {
    const s = String(text || "").trim();
    const m = s.match(/^(?:https?:\/\/)?(?:(?:www|ptb|canary)\.)?discord(?:app)?\.com\/channels\/(@me|\d{15,22})\/(\d{15,22})(?:\/\d{15,22})?\/?(?:[?#]\S*)?$/i)
      || s.match(/^discord:\/\/-?\/?channels\/(@me|\d{15,22})\/(\d{15,22})(?:\/\d{15,22})?\/?$/i);
    if (m) return { place: m[1].toLowerCase() === "@me" ? "@me" : m[1], chat: m[2] };
    const id = s.match(/^\d{15,22}$/); // a bare chat number: a direct message
    return id ? { place: "@me", chat: id[0] } : null;
  }
  let chatsKey = "";
  function paintChats(chats) {
    const key = JSON.stringify([chats, DC.busy]);
    if (key === chatsKey) return;
    chatsKey = key;
    const ul = $("#discord-chats");
    ul.replaceChildren();
    chats.forEach((c, i) => {
      const li = document.createElement("li"); li.className = "dc-chat";
      const open = document.createElement("button"); open.type = "button"; open.className = "dc-open"; open.disabled = DC.busy;
      open.title = `Open ${c.name} in Discord`;
      const ava = document.createElement("span"); ava.className = "dc-ava"; ava.setAttribute("aria-hidden", "true");
      ava.textContent = [...c.name.trim()][0]?.toUpperCase() || "#";
      let h = 0; for (const ch of c.name) h = (h * 31 + ch.codePointAt(0)) % 360;
      ava.style.setProperty("--h", String(h));
      const text = document.createElement("span"); text.className = "dc-text";
      const name = document.createElement("span"); name.className = "dc-name"; name.dir = "auto"; name.textContent = c.name;
      const kind = document.createElement("span"); kind.className = "dc-kind"; kind.textContent = c.place === "@me" ? "Direct message" : "Server chat";
      text.append(name, kind); open.append(ava, text);
      open.addEventListener("click", () => openChat(c));
      const del = document.createElement("button"); del.type = "button"; del.className = "icon-btn dc-del";
      del.title = `Unpin ${c.name}`; del.setAttribute("aria-label", `Unpin ${c.name}`);
      del.innerHTML = '<svg class="i"><use href="#i-x"/></svg>';
      del.addEventListener("click", () => saveChats(pinnedChats().filter((_, j) => j !== i), `Unpinned ${c.name}.`));
      li.append(open, del); ul.append(li);
    });
  }
  async function saveChats(list, done) {
    const s = await tryApi("/api/settings", { discordChats: list });
    if (!s) return false;
    B.S.settings = s; chatsKey = ""; paintDiscord();
    if (done) toast(done, "ok");
    return true;
  }
  function addForm(open) {
    $("#discord-add-form").hidden = !open;
    $("#discord-add").setAttribute("aria-expanded", String(open));
    $("#discord-add").classList.toggle("on", open);
    if (open) { $("#discord-add-form").reset(); $("#discord-add-name").focus(); }
  }
  $("#discord-add").addEventListener("click", () => addForm($("#discord-add-form").hidden));
  $("#discord-add-cancel").addEventListener("click", () => addForm(false));
  $("#discord-add-form").addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); addForm(false); } });
  $("#discord-add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#discord-add-name").value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
    const where = parseChatLink($("#discord-add-link").value);
    if (!name) { toast("Give the chat a name.", "err"); $("#discord-add-name").focus(); return; }
    if (!where) { toast("That is not a Discord chat link. It looks like https://discord.com/channels/…", "err", 6000); $("#discord-add-link").focus(); return; }
    const list = pinnedChats();
    if (list.some((c) => c.place === where.place && c.chat === where.chat)) { toast("That chat is already pinned.", "err"); return; }
    if (list.length >= 24) { toast("Up to 24 chats can be pinned.", "err"); return; }
    if (await saveChats([...list, { name, ...where }], `Pinned ${name}.`)) addForm(false);
  });
  async function openChat(c) {
    if (DC.busy) return;
    if (shell?.discord && DC.installed) {
      // The desktop window opens it, so Discord comes to the front next to AI Brain.
      DC.busy = true; paintDiscord();
      toast(`Opening ${c.name} in Discord…`, "ok");
      let r = null;
      try { r = await shell.discord("chat", c); } catch { r = { ok: false }; }
      DC.busy = false;
      if (!r?.ok) toast(BESIDE_WHY[r?.why] || "Could not open that chat.", "err", 6000);
      else if (r.why && BESIDE_WHY[r.why]) toast(`The chat is open. ${BESIDE_WHY[r.why]}`, "", 6000);
      if (r?.ok) DC.beside = !!r.beside;
      checkDiscord();
      return;
    }
    if (await tryApi("/api/discord/open", { chat: { place: c.place, chat: c.chat } })) toast(`Opening ${c.name} in Discord…`, "ok");
    setTimeout(checkDiscord, 2500);
  }
  async function checkDiscord() {
    clearTimeout(DC.timer);
    try {
      const s = await api("/api/discord");
      DC.installed = !!s.installed; DC.running = !!s.running;
      if (shell?.discord) { const w = await shell.discord("state"); DC.beside = !!w?.beside; }
    } catch { /* the app server is restarting; try again soon */ }
    paintDiscord();
    DC.timer = isShown("discord") && !document.hidden ? setTimeout(checkDiscord, 5000) : 0;
  }
  function discordWanted() { if (!DC.timer) checkDiscord(); }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && isShown("discord")) checkDiscord(); });
  const BESIDE_WHY = {
    "not-installed": "The Discord app was not found on this PC.",
    "not-running": "Discord did not start. Open it once, then try again.",
    "no-window": "Discord's window did not appear. Open it from the tray, then try again.",
    "screen-too-small": "The screen is too narrow for Discord and AI Brain side by side.",
    busy: "Still moving the windows…",
    "bad-chat": "That pinned chat has a broken link. Unpin it and pin it again.",
  };
  async function discordWindows(what) {
    if (!shell?.discord || DC.busy) return;
    DC.busy = true; paintDiscord();
    if (what === "beside") toast("Opening Discord beside AI Brain…", "ok");
    let r = null;
    try { r = await shell.discord(what); } catch { r = { ok: false }; }
    DC.busy = false;
    if (r?.ok) DC.beside = !!r.beside;
    else toast(BESIDE_WHY[r?.why] || "Could not move the Discord window.", "err", 6000);
    checkDiscord();
  }
  $("#discord-start").addEventListener("click", async () => {
    if (shell?.discord && DC.installed) {
      // The desktop window opens it itself, so Discord comes to the front instead of opening behind.
      if (DC.busy) return;
      DC.busy = true; paintDiscord();
      toast(DC.running ? "Bringing Discord to the front…" : "Opening the Discord app…", "ok");
      let r = null;
      try { r = await shell.discord("front"); } catch { r = { ok: false }; }
      DC.busy = false;
      if (!r?.ok) toast(BESIDE_WHY[r?.why] || "Could not open the Discord app.", "err", 6000);
      checkDiscord();
      return;
    }
    const r = await tryApi("/api/discord/open", {});
    if (r) toast(DC.running ? "Bringing Discord to the front…" : "Opening the Discord app…", "ok");
    setTimeout(checkDiscord, 2500);
  });
  $("#discord-beside").addEventListener("click", () => discordWindows("beside"));
  $("#discord-back").addEventListener("click", () => discordWindows("back"));
  paintDiscord();

  // ---------- a program in the middle (Blender, Godot, Chrome, ...) ----------
  // The desktop window keeps the program's own window on #av-slot. This page only says where the
  // slot is and whether the program may show there. It never sees program paths: only the ids of
  // programs picked in the Windows file picker, and window numbers from the list it was shown.
  const AP = { pins: [], docked: null, starting: "", busy: false, wins: null };
  const FLOW = { id: "builtin-flow", name: "Google Flow", url: "https://labs.google/fx/tools/flow" };
  const AP_WHY = {
    "not-a-program": "Pick a program (.exe) or a shortcut to one.",
    "bad-shortcut": "That shortcut could not be read.",
    discord: "Discord opens from the Discord panel, not here.",
    "ai-brain": "AI Brain cannot be shown inside itself.",
    "too-many": "Up to 24 programs can be added.",
    "not-found": "That program is no longer on this PC. Remove it and add it again.",
    "no-pin": "That program was removed.",
    "no-window": "The program's window did not appear. If it opened, use “Use a window that is open”.",
    "flow-window": "Google Flow's window did not appear. If it opened in your browser, you can use it there.",
    admin: "That program runs as administrator, so AI Brain cannot move it. Open it normally and try again.",
    gone: "That window is closed now.",
    "not-a-main-window": "That window cannot be moved into AI Brain.",
    busy: "Still working on the last one…",
    "helper-stopped": "The window helper stopped. Try again.",
    "no-answer": "The program did not answer. It may be busy; try again.",
  };
  const apWhy = (r, fallback) => { if (r?.why !== "canceled") toast(AP_WHY[r?.why] || fallback, "err", 7000); };
  const appCovered = () => !!document.querySelector("dialog[open]") || !$("#menu").hidden
    || !!document.querySelector(".panel.max") || document.body.classList.contains("zen")
    || !$("#drop").hidden || !$("#closed").hidden // the whole-page "drop files" and "closed" screens
    || document.body.classList.contains("moving") // a panel is being dragged: show where it can go
    || document.body.classList.contains("dragging") // a size is being changed: the program follows once, on let go
    || $("#appview").hasAttribute("data-covered"); // free-floating: a panel lies over the program

  let slotKey = "", slotRaf = 0;
  function slotSoon() { if (shell?.apps && !slotRaf) slotRaf = requestAnimationFrame(sendSlot); }
  function sendSlot() {
    slotRaf = 0;
    const r = $("#av-slot").getBoundingClientRect();
    const covered = appCovered();
    const show = !!AP.docked && !$("#appview").hidden && r.width > 40 && r.height > 40 && !covered;
    paintAppNote(covered);
    const s = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), show };
    const key = JSON.stringify(s);
    if (key === slotKey) return;
    slotKey = key;
    shell.apps("slot", s).catch(() => {});
  }
  function paintAppNote(covered) {
    const name = AP.docked?.name || AP.starting || "The program";
    $("#av-note-title").textContent = AP.docked ? (covered ? `${name} is behind AI Brain` : `${name} is here`) : `Starting ${name}…`;
    $("#av-note-text").textContent = AP.docked
      ? (covered ? "It comes back when you close the window or menu that is open." : "If you cannot see it, press “Use it”.")
      : "Big programs can take a little while to open.";
  }

  let pinsKey = "";
  function paintApps() {
    const has = !!shell?.apps;
    const on = !!(AP.docked || AP.starting);
    $("#appview").hidden = !on;
    document.body.classList.toggle("has-app", on);
    $("#av-name").textContent = AP.docked?.name || AP.starting || "Program";
    $("#av-title").textContent = AP.docked?.title && AP.docked.title !== AP.docked.name ? AP.docked.title : "";
    $("#av-front").disabled = $("#av-back").disabled = !AP.docked;
    $("#apps-add").disabled = !has || AP.busy;
    $("#apps-windows").disabled = !has || AP.busy;
    $("#apps-back").hidden = !AP.docked;
    {
      const here = AP.docked?.pin === FLOW.id;
      $("#apps-flow-row").classList.toggle("on", here);
      $("#apps-flow").disabled = has && AP.busy;
      $("#apps-flow").title = !has ? "Open Google Flow in your browser" : here ? "Google Flow is in the middle" : "Open Google Flow in the middle";
      $("#apps-flow-kind").textContent = here ? "In the middle now" : AP.starting === FLOW.name ? "Opening…" : has ? "Google's video maker" : "Google's video maker · opens in your browser";
    }
    $("#apps-note").hidden = has && AP.pins.length > 0;
    $("#apps-note-title").textContent = has ? "Show a program in the middle" : "Only in the desktop window";
    $("#apps-note-text").textContent = has
      ? "Press + and pick a program, like Blender, Godot or Chrome. A click on it opens it in the middle of AI Brain, where you can use it and watch it change."
      : "Programs can be shown in the middle only in the AI Brain desktop window. Open AI Brain from its desktop shortcut.";
    const key = JSON.stringify([AP.pins, AP.busy, AP.docked?.pin || "", AP.starting]);
    if (key !== pinsKey) {
      pinsKey = key;
      const ul = $("#apps-pins");
      ul.replaceChildren();
      for (const p of AP.pins) {
        const here = AP.docked?.pin === p.id;
        const li = document.createElement("li"); li.className = "dc-chat" + (here ? " on" : "");
        const open = document.createElement("button"); open.type = "button"; open.className = "dc-open"; open.disabled = AP.busy || !has;
        open.title = here ? `${p.name} is in the middle` : `Open ${p.name} in the middle`;
        let pic;
        if (p.icon && /^data:image\/png;base64,/.test(p.icon)) { pic = document.createElement("img"); pic.className = "ap-icon"; pic.alt = ""; pic.src = p.icon; }
        else { pic = document.createElement("span"); pic.className = "dc-ava"; pic.textContent = [...p.name.trim()][0]?.toUpperCase() || "#"; }
        pic.setAttribute("aria-hidden", "true");
        const text = document.createElement("span"); text.className = "dc-text";
        const name = document.createElement("span"); name.className = "dc-name"; name.dir = "auto"; name.textContent = p.name;
        const kind = document.createElement("span"); kind.className = "dc-kind";
        kind.textContent = !p.found ? "Not found on this PC" : here ? "In the middle now" : AP.starting === p.name ? "Opening…" : "Program";
        text.append(name, kind); open.append(pic, text);
        open.addEventListener("click", () => openApp(p));
        const del = document.createElement("button"); del.type = "button"; del.className = "icon-btn dc-del";
        del.title = `Remove ${p.name}`; del.setAttribute("aria-label", `Remove ${p.name}`);
        del.innerHTML = '<svg class="i"><use href="#i-x"/></svg>';
        del.addEventListener("click", () => removeApp(p));
        li.append(open, del); ul.append(li);
      }
    }
    slotSoon();
  }
  async function appsCall(what, arg) {
    try { return await shell.apps(what, arg); } catch { return { ok: false }; }
  }
  async function refreshApps() {
    if (!shell?.apps) { paintApps(); return; }
    const r = await appsCall("state");
    if (r?.ok) { AP.pins = Array.isArray(r.pins) ? r.pins : []; AP.docked = r.docked || null; }
    paintApps();
  }
  async function openApp(p) {
    if (AP.busy || !shell?.apps) return;
    if (AP.docked?.pin === p.id) { appsCall("front"); return; }
    AP.busy = true; AP.starting = p.name; paintApps();
    const r = await appsCall("open", p.id);
    AP.busy = false; AP.starting = "";
    if (!r?.ok) apWhy(r, `Could not open ${p.name}.`);
    await refreshApps();
  }
  // Google Flow has no way in for other programs: it opens as a browser window of its own, shown
  // in the middle (desktop window) or in a new tab (plain browser). You sign in to Google there.
  // byBrain: the brain asked for it (it waits for the window). signIn: open without the brain's
  // control port, only to sign in to Google when Google refuses the sign-in otherwise.
  async function openFlow(byBrain = false, signIn = false) {
    if (byBrain === true && !shell?.apps) return;
    if (!shell?.apps) { window.open(FLOW.url, "_blank", "noopener"); return; }
    if (AP.busy) { if (byBrain !== true) toast(AP_WHY.busy); return; }
    if (AP.docked?.pin === FLOW.id && !signIn) { appsCall("front"); return; }
    if (byBrain === true) toast("The brain is opening Google Flow.", "ok");
    AP.busy = true; AP.starting = FLOW.name; paintApps();
    const r = await appsCall(signIn ? "flow-signin" : "flow");
    AP.busy = false; AP.starting = "";
    if (r?.ok && r.outside) toast("Google Flow opened in your browser.", "ok");
    else if (!r?.ok) apWhy(r, "Could not open Google Flow.");
    await refreshApps();
  }
  async function removeApp(p) {
    if (AP.busy) return;
    const r = await appsCall("remove", p.id);
    if (r?.ok) { AP.pins = r.pins || []; toast(`Removed ${p.name}.`, "ok"); }
    paintApps();
  }
  async function appBack() {
    if (!AP.docked) { toast("No program is in the middle."); return; }
    const name = AP.docked.name;
    const r = await appsCall("release");
    if (r?.ok) toast(`${name} went back where it was.`, "ok");
    await refreshApps();
  }
  $("#apps-flow").addEventListener("click", openFlow);
  $("#apps-add").addEventListener("click", async () => {
    if (AP.busy || !shell?.apps) return;
    AP.busy = true; paintApps();
    const r = await appsCall("add");
    AP.busy = false;
    if (Array.isArray(r?.pins)) AP.pins = r.pins;
    if (r?.ok) { const p = AP.pins.find((x) => x.id === r.id); toast(`Added ${p?.name || "the program"}. Click it to open it in the middle.`, "ok"); }
    else apWhy(r, "Could not add that program.");
    paintApps();
  });
  function paintWins() {
    const ul = $("#apps-wins");
    ul.hidden = !AP.wins;
    $("#apps-windows").setAttribute("aria-expanded", String(!!AP.wins));
    $("#apps-windows").classList.toggle("on", !!AP.wins);
    ul.replaceChildren();
    if (!AP.wins) return;
    if (!AP.wins.length) {
      const li = document.createElement("li"); li.className = "ap-none"; li.textContent = "No other windows are open."; ul.append(li); return;
    }
    for (const w of AP.wins) {
      const li = document.createElement("li"); li.className = "dc-chat";
      const b = document.createElement("button"); b.type = "button"; b.className = "dc-open"; b.title = `Show “${w.title}” in the middle`;
      const text = document.createElement("span"); text.className = "dc-text";
      const name = document.createElement("span"); name.className = "dc-name"; name.dir = "auto"; name.textContent = w.title;
      const kind = document.createElement("span"); kind.className = "dc-kind"; kind.textContent = w.min ? `${w.app} · minimized` : w.app;
      text.append(name, kind); b.append(text);
      b.addEventListener("click", () => dockWin(w));
      li.append(b); ul.append(li);
    }
  }
  async function dockWin(w) {
    if (AP.busy) return;
    AP.busy = true; AP.wins = null; paintWins(); paintApps();
    const r = await appsCall("dock", w.hwnd);
    AP.busy = false;
    if (!r?.ok) apWhy(r, "Could not move that window.");
    await refreshApps();
  }
  $("#apps-windows").addEventListener("click", async () => {
    if (AP.wins) { AP.wins = null; paintWins(); return; }
    if (AP.busy || !shell?.apps) return;
    const r = await appsCall("windows");
    if (!r?.ok) { apWhy(r, "Could not list the open windows."); return; }
    AP.wins = Array.isArray(r.windows) ? r.windows : [];
    paintWins();
  });
  $("#apps-back").addEventListener("click", appBack);
  $("#av-back").addEventListener("click", appBack);
  $("#av-front").addEventListener("click", () => appsCall("front"));
  shell?.onApps?.((m) => {
    if (m.ev === "starting") AP.starting = String(m.name || "");
    else if (m.ev === "docked") { AP.docked = { name: String(m.name || "Program"), title: String(m.title || ""), pin: String(m.pin || "") }; AP.starting = ""; }
    else if (m.ev === "closed") { AP.docked = null; toast(`${m.name || "The program"} was closed.`); }
    else if (m.ev === "moved-away") { AP.docked = null; toast(`${m.name || "The program"} was moved out of AI Brain. It stays where you put it.`, "", 6000); }
    else if (m.ev === "released") AP.docked = null;
    else if (m.ev === "brain-control") { brainUsing(m); return; }
    paintApps();
  });

  // ---------- the brain uses the program in the middle ----------
  // The server passes each step the brain asks for (look, click, type...) here; the desktop window
  // does it and the answer goes back. The page never picks the program: it is always the one in the middle.
  let brainTimer = 0;
  function brainUsing(m) {
    clearTimeout(brainTimer);
    const badge = $("#av-brain");
    if (m.on) {
      badge.hidden = false;
      // Hidden again a little after the last step.
      brainTimer = setTimeout(() => { badge.hidden = true; }, 15000);
    } else {
      badge.hidden = true;
      if (m.why === "user") toast("You moved the mouse, so the brain stopped using the program. It is yours again.", "", 6000);
    }
  }
  async function control(ev) {
    const answer = (result, soft = false) => fetch("/api/apps/control/answer", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: ev.id, soft, result }),
    }).catch(() => {});
    // A plain browser tab cannot do it; its "no" only counts if no desktop window answers.
    if (!shell?.apps) return answer({ ok: false, why: "AI Brain's desktop window is not open, and the brain can only use programs there. Ask the user to open AI Brain from its desktop shortcut." }, true);
    let r;
    try { r = await shell.apps("control", { cmd: ev.cmd, task: ev.task, args: ev.args }); }
    catch (e) { r = { ok: false, why: String(e?.message || e) }; }
    if (ev.cmd === "open") await refreshApps();
    return answer(r || { ok: false, why: "no answer" });
  }

  // Keep the program on the slot, and behind AI Brain while a dialog, menu or big panel is open.
  new ResizeObserver(slotSoon).observe($("#av-slot"));
  window.addEventListener("resize", slotSoon);
  window.addEventListener("brain:layout", slotSoon); // panels moved or resized (a size watcher misses a pure move)
  new MutationObserver((list) => {
    for (const m of list) {
      const t = m.target;
      if (t === document.body || t.tagName === "DIALOG" || t.id === "menu" || t.id === "drop" || t.id === "closed" || t.classList?.contains("panel")) { slotSoon(); return; }
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open", "hidden", "class"] });
  refreshApps();

  // ---------- full screen and the desktop window ----------
  function fullscreen() {
    if (shell?.toggleFullscreen) { shell.toggleFullscreen(); return; }
    if (document.fullscreenElement) document.exitFullscreen?.();
    else document.documentElement.requestFullscreen?.().catch(() => toast("Full screen is not allowed here. Press F11 in your browser."));
  }
  $("#btn-full").addEventListener("click", fullscreen);
  function paintFull(on) {
    $("#btn-full").classList.toggle("on", !!on);
    $("#btn-full").title = on ? "Leave full screen (F11)" : "Full screen (F11)";
    root.style.setProperty("--win-gap", shell && !on ? `${shell.controlsWidth || 140}px` : "0px");
  }
  document.addEventListener("fullscreenchange", () => paintFull(!!document.fullscreenElement));
  if (shell) {
    document.body.classList.add("in-shell");
    shell.onFullscreen?.((on) => paintFull(on));
    paintFull(!!shell.isFullscreen);
  }
  function opaque(color, fallback) {
    // The window buttons need a solid colour: blend a translucent panel colour over black.
    const m = /rgba?\(([^)]+)\)/.exec(color || "");
    if (!m) return fallback;
    const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    const hex = (v) => Math.round(v * a).toString(16).padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}`;
  }
  function paintShellColors() {
    if (!shell?.setColors) return;
    const top = getComputedStyle($("#top"));
    shell.setColors({ color: opaque(top.backgroundColor, "#151619"), symbol: opaque(getComputedStyle($("#session-title")).color, "#9a9fa9"), height: Math.round($("#top").getBoundingClientRect().height) });
  }

  // ---------- hooks called from app.js ----------
  let firstSettings = true;
  window.Station = {
    preset, saveMine, show, hide, fullscreen, appBack, setFloat, move, moveSide, openFlow, control, hasShell: () => !!shell?.apps,
    // For tests and the palette: the layout tree and where everything is drawn (pixels inside #tiles).
    layout: () => ({ root: clone(L.root), rects: clone(RECTS), splits: SPLITS.map((s) => ({ x: s.x, y: s.y, w: s.w, h: s.h, horiz: s.horiz, off: s.off })), float: !!L.float, preset: L.preset, collapsed: [...L.collapsed], saved: clone(L) }),
    mode: (m) => setMode(m),
    currentMode: () => mode,
    music: (cmd) => musicCmd(cmd),
    helperBusy(who, on) { railBtns[who]?.classList.toggle("busy", !!on); },
    chatgpt() { render(); },
    settings(s) {
      if (typeof s.layout === "string" && s.layout && s.layout !== lastSaved && s.layout !== serial()) {
        let parsed = null;
        try { parsed = clean(JSON.parse(s.layout)); } catch { /* broken layout: keep the current one */ }
        if (parsed) { L = parsed; lastSaved = s.layout; }
      } else if (firstSettings && !s.layout) {
        lastSaved = "";
      }
      firstSettings = false;
      render();
      paintStatusBar();
      paintDiscord();
      tick();
      requestAnimationFrame(paintShellColors);
    },
    event(ev) {
      switch (ev.type) {
        case "ready": paintMeters(); paintStatusBar(); statsSoon(50); break;
        case "hello": statsSoon(300); break;
        case "usage": paintMeters(); break;
        case "busy": paintStatusBar(); break;
        case "final": statsSoon(); break;
        case "reply": statsSoon(); break;
        case "task": if (!B.S.replaying) statsSoon(); break;
        case "media": case "video_state": statsSoon(); break;
        default: break;
      }
    },
  };

  // ---------- start ----------
  const cached = clean(store.get("layout", null));
  if (cached) L = cached;
  render();
  paintMode();
  paintMusic();
  musicSoon();
  setInterval(() => { if (!document.hidden && !B.S.closing) loadStats(); }, 60_000);
})();
