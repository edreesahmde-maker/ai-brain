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

  // ---------- panels and presets ----------
  const PANELS = {
    gemini: { label: "Gemini", icon: "star", side: "left", f: 1.6 },
    chatgpt: { label: "ChatGPT", icon: "users", side: "left", f: 1.2 },
    activity: { label: "Activity", icon: "activity", side: "left", f: 1 },
    usage: { label: "Usage", icon: "gauge", side: "right", f: 2.1 },
    stats: { label: "This session", icon: "bars", side: "right", f: 0.5 },
    recent: { label: "Recent images", icon: "image", side: "left", f: 0.7 },
    music: { label: "Music", icon: "music", side: "right", f: 0.8 },
    discord: { label: "Discord", icon: "chat", side: "right", f: 2.2 },
  };
  const IDS = Object.keys(PANELS);
  const PRESETS = {
    focus: { left: { w: 300, items: [] }, right: { w: 300, items: [] } },
    station: { left: { w: 310, items: ["gemini", "activity"] }, right: { w: 300, items: ["usage", "music", "stats"] } },
    all: { left: { w: 310, items: ["gemini", "activity", "recent"] }, right: { w: 330, items: ["usage", "music", "discord", "stats"] } },
    social: { left: { w: 300, items: ["gemini"] }, right: { w: 440, items: ["discord", "music"] } },
  };
  const PRESET_NAMES = { focus: "Focus", station: "Station", all: "Everything", social: "Social", mine: "Mine" };
  const chatgptOn = () => !!B.S.settings?.chatgptEnabled;
  const usable = (id) => id !== "chatgpt" || chatgptOn();

  let L = fromPreset("station");
  let lastSaved = "";
  function fromPreset(name, base) {
    const p = name === "mine" ? base?.mine : PRESETS[name];
    if (!p) return null;
    const out = {
      v: 1, preset: name,
      left: { w: p.left.w, items: [...p.left.items] }, right: { w: p.right.w, items: [...p.right.items] },
      sizes: { ...(p.sizes || {}) }, collapsed: [...(p.collapsed || [])], mine: base?.mine || null,
    };
    if (name === "all" && chatgptOn()) out.left.items.splice(1, 0, "chatgpt");
    return out;
  }
  function clean(x) {
    // Never trust a saved layout blindly: keep known panels, each in one place, sane widths.
    if (!x || typeof x !== "object") return null;
    const seen = new Set();
    const side = (s) => {
      const items = (Array.isArray(s?.items) ? s.items : []).filter((id) => PANELS[id] && !seen.has(id) && seen.add(id));
      const w = Math.round(Number(s?.w));
      return { w: w >= 200 && w <= 1400 ? w : 300, items };
    };
    const out = { v: 1, preset: typeof x.preset === "string" ? x.preset : "", left: side(x.left), right: side(x.right), sizes: {}, collapsed: [], mine: null };
    for (const id of IDS) { const f = Number(x.sizes?.[id]); if (f > 0.05 && f < 50) out.sizes[id] = Math.round(f * 1000) / 1000; }
    out.collapsed = (Array.isArray(x.collapsed) ? x.collapsed : []).filter((id) => PANELS[id]);
    if (x.mine && typeof x.mine === "object") {
      const m = clean({ ...x.mine, mine: null });
      if (m) out.mine = { left: m.left, right: m.right, sizes: m.sizes, collapsed: m.collapsed };
    }
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
  const railBtns = {};
  for (const id of IDS) {
    const p = PANELS[id];
    const b = h("button", { type: "button", class: "icon-btn", "data-toggle": id, title: `${p.label} – show or hide`, "aria-label": `Show or hide ${p.label}`, "aria-pressed": "false" }, icon(p.icon));
    b.addEventListener("click", () => (isShown(id) ? hide(id) : show(id)));
    railBtns[id] = b;
    $("#rail-panels").append(b);
    const panel = $(`[data-panel="${id}"]`);
    const head = $(".p-head", panel);
    const more = h("button", { type: "button", class: "icon-btn p-more", title: "Panel menu: move, resize or hide", "aria-label": `${p.label} panel menu`, "aria-haspopup": "menu" }, icon("dots"));
    more.addEventListener("click", (e) => { e.stopPropagation(); panelMenu(id, more); });
    head.append(more);
    head.addEventListener("dblclick", (e) => { if (!e.target.closest("button, input, textarea, select, a")) toggleCollapse(id); });
  }
  const panelEl = (id) => $(`[data-panel="${id}"]`);
  const sideOf = (id) => (L.left.items.includes(id) ? "left" : L.right.items.includes(id) ? "right" : "");
  const isShown = (id) => !!sideOf(id) && usable(id);

  function show(id, opts = {}) {
    if (!PANELS[id]) return;
    if (!usable(id)) { toast("Turn ChatGPT on in Settings first."); return; }
    if (document.body.classList.contains("zen")) B.setZen(false);
    if (!sideOf(id)) {
      const side = opts.side || L.home?.[id] || PANELS[id].side;
      L[side].items.push(id);
    }
    L.collapsed = L.collapsed.filter((x) => x !== id);
    changed();
    const el = panelEl(id);
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    if (id === "discord") discordWanted();
  }
  function hide(id) {
    const side = sideOf(id);
    if (!side) return;
    L.home = { ...(L.home || {}), [id]: side };
    L[side].items = L[side].items.filter((x) => x !== id);
    const max = $(".panel.max");
    if (max && max === panelEl(id)) B.toggleMax(max, false);
    changed();
  }
  function toggleCollapse(id) {
    L.collapsed = L.collapsed.includes(id) ? L.collapsed.filter((x) => x !== id) : [...L.collapsed, id];
    changed();
  }
  function move(id, delta) {
    const side = sideOf(id);
    const list = L[side].items, i = list.indexOf(id), j = i + delta;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    changed();
  }
  function moveSide(id) {
    const from = sideOf(id), to = from === "left" ? "right" : "left";
    L[from].items = L[from].items.filter((x) => x !== id);
    L[to].items.push(id);
    changed();
  }

  // ---------- render ----------
  function place(dock, wanted) {
    // Only move nodes that are out of place, so panels keep their scroll position and focus.
    for (let i = 0; i < wanted.length; i++) if (dock.children[i] !== wanted[i]) dock.insertBefore(wanted[i], dock.children[i] || null);
    while (dock.children.length > wanted.length) {
      const extra = dock.lastElementChild;
      if (extra.classList.contains("hsplit")) extra.remove(); else $("#panel-store").append(extra);
    }
  }
  const splitPool = [];
  function render() {
    const store0 = $("#panel-store");
    const used = new Set();
    for (const side of ["left", "right"]) {
      const dock = $(`#dock-${side}`);
      const items = L[side].items.filter(usable);
      items.forEach((id) => used.add(id));
      const wanted = [];
      items.forEach((id, i) => {
        if (i) {
          const prev = items[i - 1];
          let sp = [...dock.children].find((c) => c.classList.contains("hsplit") && c.dataset.a === prev && c.dataset.b === id);
          if (!sp) sp = splitPool.pop() || makeHsplit();
          sp.dataset.a = prev; sp.dataset.b = id;
          sp.classList.toggle("off", L.collapsed.includes(prev) || L.collapsed.includes(id));
          wanted.push(sp);
        }
        wanted.push(panelEl(id));
      });
      place(dock, wanted);
      dock.hidden = !items.length;
      $(`.vsplit[data-side="${side}"]`).hidden = !items.length;
      dock.style.setProperty("--w", `${L[side].w}px`);
    }
    for (const id of IDS) {
      const el = panelEl(id);
      if (!used.has(id) && el.parentNode !== store0) store0.append(el);
      el.style.setProperty("--f", String(L.sizes[id] || PANELS[id].f));
      el.classList.toggle("collapsed", L.collapsed.includes(id));
      const b = railBtns[id];
      b.hidden = !usable(id);
      b.classList.toggle("on", used.has(id));
      b.setAttribute("aria-pressed", String(used.has(id)));
    }
    for (const b of $$("#presets [data-preset]")) b.setAttribute("aria-pressed", String(b.dataset.preset === L.preset));
    $('#presets [data-preset="mine"]').hidden = !L.mine;
    if (isShown("discord")) discordWanted();
    musicSoon();
    if (isShown("usage")) paintUsagePanel();
  }

  // ---------- splitters ----------
  function makeHsplit() {
    const sp = h("div", { class: "hsplit", role: "separator", "aria-orientation": "horizontal", tabindex: "0", "aria-label": "Resize the panels above and below" });
    sp.addEventListener("pointerdown", (e) => hDrag(e, sp));
    sp.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      nudgeH(sp, e.key === "ArrowUp" ? -24 : 24);
    });
    return sp;
  }
  function weights(sp) {
    const a = panelEl(sp.dataset.a), b = panelEl(sp.dataset.b);
    return { a, b, fa: L.sizes[sp.dataset.a] || PANELS[sp.dataset.a].f, fb: L.sizes[sp.dataset.b] || PANELS[sp.dataset.b].f, ha: a.getBoundingClientRect().height, hb: b.getBoundingClientRect().height };
  }
  function setPair(sp, w, newHa) {
    const total = w.ha + w.hb, sum = w.fa + w.fb;
    const ha = Math.max(60, Math.min(total - 60, newHa));
    const fa = Math.round((sum * ha / total) * 1000) / 1000;
    L.sizes[sp.dataset.a] = fa;
    L.sizes[sp.dataset.b] = Math.round((sum - fa) * 1000) / 1000;
    w.a.style.setProperty("--f", String(L.sizes[sp.dataset.a]));
    w.b.style.setProperty("--f", String(L.sizes[sp.dataset.b]));
  }
  function nudgeH(sp, dy) {
    if (sp.classList.contains("off")) return;
    const w = weights(sp);
    setPair(sp, w, w.ha + dy);
    L.preset = ""; render(); save();
  }
  function hDrag(e, sp) {
    if (e.button !== 0 || sp.classList.contains("off")) return;
    e.preventDefault();
    const w = weights(sp), y0 = e.clientY;
    sp.setPointerCapture(e.pointerId);
    sp.classList.add("drag");
    document.body.classList.add("dragging");
    const mv = (ev) => setPair(sp, w, w.ha + ev.clientY - y0);
    const up = () => {
      sp.removeEventListener("pointermove", mv);
      sp.classList.remove("drag");
      document.body.classList.remove("dragging");
      L.preset = ""; render(); save();
    };
    sp.addEventListener("pointermove", mv);
    sp.addEventListener("pointerup", up, { once: true });
    sp.addEventListener("pointercancel", up, { once: true });
  }
  function clampW(side, w) {
    const other = side === "left" ? "right" : "left";
    const otherW = $(`#dock-${other}`).hidden ? 0 : L[other].w;
    const max = Math.max(200, Math.min(window.innerWidth * 0.46, window.innerWidth - otherW - 440));
    return Math.round(Math.max(200, Math.min(max, w)));
  }
  for (const vs of $$(".vsplit")) {
    const side = vs.dataset.side;
    vs.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const x0 = e.clientX, w0 = L[side].w, dock = $(`#dock-${side}`);
      vs.setPointerCapture(e.pointerId);
      vs.classList.add("drag");
      document.body.classList.add("dragging");
      const mv = (ev) => { L[side].w = clampW(side, w0 + (side === "left" ? 1 : -1) * (ev.clientX - x0)); dock.style.setProperty("--w", `${L[side].w}px`); };
      const up = () => { vs.removeEventListener("pointermove", mv); vs.classList.remove("drag"); document.body.classList.remove("dragging"); L.preset = ""; render(); save(); };
      vs.addEventListener("pointermove", mv);
      vs.addEventListener("pointerup", up, { once: true });
      vs.addEventListener("pointercancel", up, { once: true });
    });
    vs.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const grow = (e.key === "ArrowRight") === (side === "left");
      L[side].w = clampW(side, L[side].w + (grow ? 24 : -24));
      L.preset = ""; render(); save();
    });
  }

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
      const b = h("button", { type: "button", role: it.checked == null ? "menuitem" : "menuitemcheckbox", disabled: !!it.disabled }, it.icon ? icon(it.icon) : null, h("span", { text: it.label }));
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

  function panelMenu(id, anchor) {
    const side = sideOf(id), list = L[side].items.filter(usable), i = list.indexOf(id);
    const coll = L.collapsed.includes(id);
    openMenu(anchor, [
      { label: coll ? "Expand" : "Collapse to its title", icon: coll ? "down" : "up", run: () => toggleCollapse(id) },
      { label: "Make bigger (Esc to go back)", icon: "max", run: () => B.toggleMax(panelEl(id), true) },
      "-",
      { label: "Move up", icon: "up", disabled: i <= 0, run: () => move(id, -1) },
      { label: "Move down", icon: "down", disabled: i >= list.length - 1, run: () => move(id, 1) },
      { label: side === "left" ? "Move to the right side" : "Move to the left side", icon: side === "left" ? "right" : "left", run: () => moveSide(id) },
      "-",
      { label: "Hide this panel", icon: "x", run: () => hide(id) },
    ]);
  }
  $("#btn-layout").addEventListener("click", (e) => {
    const items = [{ header: "Layouts" }];
    for (const [k, name] of Object.entries(PRESET_NAMES)) {
      if (k === "mine" && !L.mine) continue;
      items.push({ label: name, checked: L.preset === k, run: () => preset(k) });
    }
    items.push({ label: "Save this layout as Mine", icon: "bookmark", run: saveMine });
    items.push("-", { header: "Panels" });
    for (const id of IDS) if (usable(id)) items.push({ label: PANELS[id].label, checked: isShown(id), run: () => (isShown(id) ? hide(id) : show(id)) });
    openMenu(e.currentTarget, items);
  });

  function preset(name) {
    const next = fromPreset(name, L);
    if (!next) { toast("Save a layout as Mine first (Layout menu)."); return; }
    next.home = L.home;
    if (document.body.classList.contains("zen")) B.setZen(false);
    const max = $(".panel.max");
    if (max) B.toggleMax(max, false);
    L = next;
    render();
    save();
  }
  function saveMine() {
    L.mine = { left: { ...L.left, items: [...L.left.items] }, right: { ...L.right, items: [...L.right.items] }, sizes: { ...L.sizes }, collapsed: [...L.collapsed] };
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
    paintChart();
  }
  function paintChart() {
    const box = $("#u-chart"), days = stats?.days || [];
    const max = Math.max(1, ...days.map((d) => d.tasks));
    const cols = days.map((d) => {
      const col = h("div", { class: "col", "data-day": d.day, "data-tasks": String(d.tasks), "data-gemini": String(d.gemini) });
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
    const t = Number(col.dataset.tasks), gm = Number(col.dataset.gemini);
    tip.replaceChildren(h("div", { text: d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) }),
      h("div", {}, h("b", { text: String(t) }), ` task${t === 1 ? "" : "s"} · `, h("b", { text: String(gm) }), ` Gemini request${gm === 1 ? "" : "s"}`));
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
      $("#sb-gemini").textContent = `Gemini ${t.calls} today${t.pictures ? ` · ${t.pictures} pic` : ""}`;
    }
  }
  new MutationObserver(paintStatusBar).observe($("#phase-label"), { childList: true, characterData: true, subtree: true });
  $("#usage").addEventListener("click", () => show("usage"));
  $("#sb-gemini").addEventListener("click", () => show("usage"));
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
    preset, saveMine, show, hide, fullscreen,
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
        case "reply": if (ev.from === "gemini" || ev.who === "gemini") statsSoon(); break;
        case "task": if (!B.S.replaying) statsSoon(); break;
        case "media": statsSoon(); break;
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
