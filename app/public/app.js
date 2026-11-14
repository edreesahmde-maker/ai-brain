"use strict";
// AI Brain - the dashboard. Talks to app-server.mjs: commands go out as small POSTs,
// everything that happens comes back as one stream of events (/events).
(() => {
  // ---------- small helpers ----------
  const root = document.documentElement;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const SVG_NS = "http://www.w3.org/2000/svg";
  const NAME = { claude: "Claude", gemini: "Gemini", chatgpt: "ChatGPT", you: "You" };
  const MODEL = { auto: "your Claude default", fable: "Fable", opus: "Opus", sonnet: "Sonnet", haiku: "Haiku" };
  const HELPERS = ["gemini", "chatgpt"];
  // Which AI is the brain (Settings > The brain > Brain): Claude, or ChatGPT. Old events have no brain: Claude.
  const brainId = () => (S.settings?.brain === "chatgpt" ? "chatgpt" : "claude");
  const brainName = () => NAME[brainId()];
  const VIDEO_RE = /\.(mp4|webm|mov)$/i;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(`brain.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`brain.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  // "What's new" is shown once to someone who used an older version here, never on a first start.
  const NEWS = 3.1;
  const newsDue = (() => {
    try {
      const used = Object.keys(localStorage).some((k) => k.startsWith("brain."));
      const seen = Number(store.get("news", 0)) || 0;
      if (!used) store.set("news", NEWS);
      return used && seen < NEWS;
    } catch { return false; }
  })();

  function svgUse(id, cls) {
    const s = document.createElementNS(SVG_NS, "svg");
    s.setAttribute("class", cls);
    s.setAttribute("aria-hidden", "true");
    const u = document.createElementNS(SVG_NS, "use");
    u.setAttribute("href", `#${id}`);
    s.append(u);
    return s;
  }
  const icon = (name) => svgUse(`i-${name}`, "i");

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  const short = (t, n) => { const s = String(t || "").replace(/\s+/g, " ").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  const clock = (t) => new Date(t || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: S.settings ? S.settings.clock24 === false : undefined });
  const dur = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  function ago(t) {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 172800) return "yesterday";
    return new Date(t).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
  }
  const isLong = (t, chars = 500, lines = 8) => t.length > chars || t.split("\n").length > lines;

  async function api(path, body) {
    const opt = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    let res;
    try { res = await fetch(path, opt); } catch { throw new Error("The app is not responding."); }
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
    return data;
  }
  async function tryApi(path, body) {
    try { return await api(path, body === undefined ? {} : body); }
    catch (e) { toast(e.message, "err"); return null; }
  }

  // ---------- state ----------
  const S = {
    settings: null, status: null, session: { id: "", title: "" }, replaying: false,
    busy: false, phase: "idle", queue: [], direct: { chatgpt: false, gemini: false, video: false },
    media: [], prompts: [], saved: [], sessions: [], attach: [], history: store.get("history", []),
    stats: { tasks: 0, calls: 0, images: new Set(), secs: [] },
    lastTask: null, taskStart: 0, taskImages: [], closing: false, studioId: null, usage: null,
  };
  const pending = new Map(); // call id -> { el, who, from, t }

  // ---------- dialogs, toasts ----------
  const dlgStack = [];
  const toastBox = $("#toasts");
  function openDlg(sel) {
    const d = typeof sel === "string" ? $(sel) : sel;
    if (!d.open) { d.showModal(); dlgStack.push(d); homeToasts(); }
    return d;
  }
  // Toasts must sit inside the top-most open dialog, or the dialog would cover them.
  function homeToasts() {
    const host = dlgStack[dlgStack.length - 1] || document.body;
    if (toastBox.parentNode !== host) host.append(toastBox);
  }
  for (const d of $$("dialog")) {
    let downOnBackdrop = false;
    d.addEventListener("mousedown", (e) => { downOnBackdrop = e.target === d; });
    d.addEventListener("click", (e) => { if (e.target === d && downOnBackdrop) d.close(); });
    d.addEventListener("close", () => {
      const i = dlgStack.indexOf(d);
      if (i >= 0) dlgStack.splice(i, 1);
      homeToasts();
    });
  }
  document.addEventListener("click", (e) => {
    const c = e.target.closest("[data-close]");
    if (c) c.closest("dialog")?.close();
    const o = e.target.closest("[data-open]");
    if (o) tryApi("/api/open", { target: o.dataset.open });
  });

  function toast(text, kind = "", ms = 4200) {
    homeToasts();
    const el = h("div", { class: `toast ${kind}`, text });
    toastBox.append(el);
    while (toastBox.children.length > 4) toastBox.firstChild.remove();
    setTimeout(() => el.remove(), ms);
  }

  function confirmBox(title, text, { yes = "OK", danger = false } = {}) {
    return new Promise((resolve) => {
      const d = $("#dlg-confirm"), y = $("#confirm-yes"), n = $("#confirm-no");
      if (d.open) { resolve(false); return; }
      $("#confirm-title").textContent = title;
      $("#confirm-text").textContent = text || "";
      y.textContent = yes;
      y.className = `btn ${danger ? "danger" : "primary"}`;
      let result = false;
      const onYes = () => { result = true; d.close(); };
      const onNo = () => d.close();
      y.addEventListener("click", onYes);
      n.addEventListener("click", onNo);
      d.addEventListener("close", () => {
        y.removeEventListener("click", onYes);
        n.removeEventListener("click", onNo);
        resolve(result);
      }, { once: true });
      openDlg(d);
      y.focus();
    });
  }
  // ---------- Claude asks before it changes a file or runs a command ----------
  // The server sends "approval" (live only, never replayed) and "approval_done" when it is answered
  // anywhere, times out or the task ends. The first answer wins. Esc counts as Deny.
  const approve = { list: [], shown: null };
  const apDlg = $("#dlg-approve");
  function approvalAdd(a) {
    if (approve.list.some((x) => x.id === a.id)) return;
    approve.list.push(a);
    paintApproval();
    chime(true);
    if (document.hidden) {
      document.title = `✋ ${brainName()} is waiting for you – AI Brain`;
      if (S.settings?.notify && "Notification" in window && Notification.permission === "granted") {
        try { const n = new Notification(`AI Brain: ${brainName()} wants to make a change`, { body: short(`${a.title}: ${a.path || a.detail}`, 140), icon: "icon.svg", tag: "ai-brain-approve" }); n.onclick = () => { window.focus(); n.close(); }; } catch { /* unavailable */ }
      }
    }
  }
  function approvalGone(id) { approve.list = approve.list.filter((x) => x.id !== id); paintApproval(); }
  function paintApproval() {
    const a = approve.list[0];
    if (!a) { approve.shown = null; if (apDlg.open) apDlg.close(); return; }
    const fresh = approve.shown !== a.id;
    approve.shown = a.id;
    $("#ap-title").textContent = a.title || `${brainName()} wants to make a change`;
    $("#ap-tool").textContent = a.tool || "";
    $("#ap-path-row").hidden = !a.path;
    $("#ap-path").textContent = a.path || "";
    $("#ap-note").hidden = !a.note;
    $("#ap-note").textContent = a.note || "";
    $("#ap-detail").textContent = a.detail || "";
    $("#ap-cwd").textContent = a.kind === "command" ? `Runs in ${a.cwd}` : "";
    $("#ap-all").hidden = !a.canAll;
    $("#ap-count").hidden = approve.list.length < 2;
    $("#ap-count").textContent = `1 of ${approve.list.length}`;
    for (const b of $$("#dlg-approve .d-foot .btn")) b.disabled = false;
    if (!apDlg.open) openDlg(apDlg);
    if (fresh) { $("#ap-detail").scrollTop = 0; $("#ap-deny").focus(); }
  }
  async function answerApproval(allow, all = false) {
    const id = approve.shown;
    if (!id) return;
    for (const b of $$("#dlg-approve .d-foot .btn")) b.disabled = true;
    approvalGone(id);
    try { await api("/api/approval/answer", { id, allow, all }); }
    catch (e) { toast(e.message, "err"); }
  }
  $("#ap-allow").addEventListener("click", () => answerApproval(true));
  $("#ap-deny").addEventListener("click", () => answerApproval(false));
  $("#ap-all").addEventListener("click", () => answerApproval(true, true));
  apDlg.addEventListener("cancel", (e) => { e.preventDefault(); answerApproval(false); });
  // Something else closed every dialog: a question that is still waiting comes straight back.
  apDlg.addEventListener("close", () => { if (approve.list.length) setTimeout(paintApproval, 0); });

  function askInput(title, value = "", { max = 70, placeholder = "" } = {}) {
    return new Promise((resolve) => {
      const d = $("#dlg-input"), inp = $("#input-value"), form = $("#input-form"), no = $("#input-no");
      if (d.open) { resolve(null); return; }
      $("#input-title").textContent = title;
      inp.maxLength = max;
      inp.placeholder = placeholder;
      inp.value = value;
      let result = null;
      const onSubmit = (e) => { e.preventDefault(); result = inp.value.trim(); d.close(); };
      const onNo = () => d.close();
      form.addEventListener("submit", onSubmit);
      no.addEventListener("click", onNo);
      d.addEventListener("close", () => {
        form.removeEventListener("submit", onSubmit);
        no.removeEventListener("click", onNo);
        resolve(result);
      }, { once: true });
      openDlg(d);
      inp.focus();
      inp.select();
    });
  }

  async function copyText(text, done = "Copied.") {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = h("textarea", { style: "position:fixed;opacity:0" });
      ta.value = text;
      (dlgStack[dlgStack.length - 1] || document.body).append(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { /* not allowed */ }
      ta.remove();
      if (!ok) { toast("Could not copy.", "err"); return; }
    }
    toast(done, "ok", 1800);
  }

  // ---------- safe Markdown ----------
  // AI replies are untrusted text. Markdown is rendered, then cleaned: no scripts, no
  // images or frames (nothing remote is ever loaded), no inline styles, safe links only.
  const PURIFY = {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ["img", "picture", "source", "style", "form", "iframe", "video", "audio", "svg", "math", "object", "embed", "link", "meta", "base", "button", "textarea", "select", "dialog", "template"],
    FORBID_ATTR: ["style", "class", "id", "name", "srcset", "action", "formaction", "background", "poster", "tabindex", "contenteditable"],
    // Same shape as the library default (plain attribute values pass), but only http, https and mailto links.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    ALLOW_DATA_ATTR: false,
  };
  // Raw HTML inside a reply is shown as plain text; only a few harmless bare tags pass through.
  const escHtml = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const NOT_PLAIN_TAG = /<(?!\/?(?:br|hr|sub|sup|kbd|u|mark|details|summary)\s*\/?>)/i;
  window.marked.use({ renderer: { html(token) { const t = token.text ?? token.raw ?? ""; return NOT_PLAIN_TAG.test(t) ? escHtml(t) : t; } } });
  function renderMd(text) {
    let html;
    try { html = window.marked.parse(String(text || ""), { gfm: true, breaks: true, async: false }); }
    catch { return document.createTextNode(String(text || "")); }
    const frag = window.DOMPurify.sanitize(html, PURIFY);
    for (const a of $$("a", frag)) {
      const href = a.getAttribute("href") || "";
      if (!/^(https?:|mailto:)/i.test(href)) { a.removeAttribute("href"); continue; }
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }
    for (const inp of $$("input", frag)) {
      if (inp.getAttribute("type") !== "checkbox") inp.remove();
      else inp.disabled = true;
    }
    for (const pre of $$("pre", frag)) {
      const btn = h("button", { class: "copy-code", type: "button", text: "Copy" });
      btn.addEventListener("click", () => copyText(pre.querySelector("code")?.textContent ?? pre.textContent.replace(/Copy$/, ""), "Code copied."));
      pre.append(btn);
    }
    for (const table of $$("table", frag)) {
      const wrap = h("div", { class: "table-wrap" });
      table.replaceWith(wrap);
      wrap.append(table);
    }
    return frag;
  }
  const mdBox = (text) => h("div", { class: "md", dir: "auto" }, renderMd(text));

  function clampable(el, long) {
    if (!long) return [el];
    el.classList.add("clamp");
    const btn = h("button", { class: "more", type: "button", text: "Show more" });
    btn.addEventListener("click", () => { btn.textContent = el.classList.toggle("clamp") ? "Show more" : "Show less"; });
    return [el, btn];
  }
  function typing() { return h("span", { class: "typing", "aria-label": "working" }, h("i"), h("i"), h("i")); }
  function act(ic, label, fn, title) {
    const b = h("button", { class: "act", type: "button", title: title || label }, icon(ic), h("span", { text: label }));
    b.addEventListener("click", () => fn(b));
    return b;
  }
  const setAct = (b, ic, label) => b.replaceChildren(icon(ic), h("span", { text: label }));
  const actions = (when, list) => h("div", { class: "actions" }, h("span", { class: "when", text: when }), ...list);

  // ---------- pictures ----------
  function mediaItem(x) {
    const it = typeof x === "string" ? { url: x } : { ...x };
    it.name = it.name || decodeURIComponent(it.url.split("?")[0].split("/").pop());
    it.isMedia = it.url.startsWith("/media/");
    if (!it.path) it.path = S.media.find((m) => m.url === it.url)?.path || null;
    return it;
  }
  function thumb(list, i, tag) {
    const it = list[i];
    const b = h("button", { class: "thumb", type: "button", title: it.name, "aria-label": `Open ${it.name}` });
    const m = VIDEO_RE.test(it.name) ? h("video", { src: it.url, muted: true, preload: "metadata" }) : h("img", { src: it.url, alt: "", loading: "lazy" });
    m.addEventListener("error", () => b.remove());
    b.append(m);
    if (tag) b.append(h("span", { class: "tag", text: tag }));
    b.addEventListener("click", () => openLight(list, list.indexOf(it)));
    return b;
  }
  function imgs(urls) {
    const list = (urls || []).map(mediaItem);
    return list.length ? h("div", { class: "imgs" }, list.map((_, i) => thumb(list, i))) : null;
  }
  function fileChips(files) {
    const pics = files.filter((f) => f.url).map(mediaItem);
    return h("div", { class: "file-chips" }, files.map((f) => {
      const chip = h("span", { class: "file-chip", title: f.name }, f.url ? h("img", { src: f.url, alt: "" }) : icon("clip"), h("span", { text: f.name }));
      if (f.url) {
        chip.style.cursor = "pointer";
        chip.addEventListener("click", () => openLight(pics, pics.findIndex((p) => p.url === f.url)));
      }
      return chip;
    }));
  }

  // ---------- conversation (centre) ----------
  const thread = $("#thread"), emptyEl = $("#empty"), jumpBtn = $("#jump");
  let liveEl = null, liveMd = null, livePhase = null, liveText = "", liveTimer = null;
  let liveDone = "", liveDoneEl = null, liveTailEl = null; // the finished part of the live answer (see paintLive)
  const atBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  function scrollDown() { thread.scrollTop = thread.scrollHeight; jumpBtn.hidden = true; }
  function addToThread(el, stick) {
    // Messages put back when a conversation opens appear at once (no fade-in for each of them).
    if (S.replaying) { el.classList?.add("old"); emptyEl.hidden = true; liveEl ? thread.insertBefore(el, liveEl) : thread.append(el); return; }
    const s = stick ?? atBottom(thread);
    emptyEl.hidden = true;
    if (liveEl) thread.insertBefore(el, liveEl); else thread.append(el);
    if (s) scrollDown(); else jumpBtn.hidden = false;
  }
  thread.addEventListener("scroll", () => { if (atBottom(thread)) jumpBtn.hidden = true; });
  jumpBtn.addEventListener("click", scrollDown);

  const avatar = () => h("div", { class: "avatar" }, svgUse("mark", ""));
  function ensureLive() {
    if (liveEl) return;
    livePhase = h("span", { text: "Thinking…" });
    liveMd = h("div", { class: "md", dir: "auto" });
    liveEl = h("div", { class: "msg claude live" }, avatar(),
      h("div", { class: "body" }, h("div", { class: "card" }, h("div", { class: "phase-line" }, typing(), livePhase), liveMd)));
    emptyEl.hidden = true;
    thread.append(liveEl);
    scrollDown();
  }
  function dropLive() {
    clearTimeout(liveTimer); liveTimer = null;
    liveEl?.remove();
    liveEl = liveMd = livePhase = null;
    liveText = ""; liveDone = ""; liveDoneEl = liveTailEl = null;
  }
  // While an answer is still arriving, close any half-written code block or bold
  // marker so the text does not flicker between raw symbols and formatting.
  function tidyPartial(text) {
    const fences = (text.match(/^\s*```/gm) || []).length;
    if (fences % 2) return text + "\n```";
    let t = text.replace(/\*+$/, "");
    const lastLine = t.slice(t.lastIndexOf("\n") + 1);
    if (((lastLine.match(/\*\*/g) || []).length) % 2) t += "**";
    return t;
  }
  // Where the finished part of a half-written answer ends: the last blank line outside a code
  // block that is followed by a new paragraph or heading (not a list item, quote, table or
  // indented text, which may still belong to what came before).
  function safeCut(t) {
    const lines = t.split("\n");
    let cut = 0, pos = 0, fence = false;
    for (let i = 0; i < lines.length - 1; i++) {
      const ln = lines[i];
      if (/^\s*(```|~~~)/.test(ln)) fence = !fence;
      pos += ln.length + 1;
      if (!fence && i > 0 && ln.trim() === "" && /^[^\s\-*+\d|>]/.test(lines[i + 1])) cut = pos;
    }
    return cut;
  }
  // Only the unfinished end of the answer is turned into formatted text again on each update; the
  // finished paragraphs above it stay as they are (a long answer no longer gets slower and slower).
  function paintLive() {
    if (!liveEl) return;
    const stick = atBottom(thread);
    if (!liveText) { liveMd.replaceChildren(); liveDone = ""; liveDoneEl = liveTailEl = null; }
    else {
      if (!liveDoneEl || !liveText.startsWith(liveDone)) {
        liveDone = "";
        liveDoneEl = h("div", { class: "md-part" }); liveTailEl = h("div", { class: "md-part" });
        liveMd.replaceChildren(liveDoneEl, liveTailEl);
      }
      const cut = safeCut(liveText);
      if (cut > liveDone.length) { liveDoneEl.append(renderMd(liveText.slice(liveDone.length, cut))); liveDone = liveText.slice(0, cut); }
      liveTailEl.replaceChildren(renderMd(tidyPartial(liveText.slice(liveDone.length))));
    }
    if (stick) scrollDown();
  }
  function setLive(text) {
    liveText = text || "";
    if (!liveEl || liveTimer) return;
    liveTimer = setTimeout(() => { liveTimer = null; paintLive(); }, 90);
  }

  function msgTask(ev) {
    const files = ev.files || [];
    return h("div", { class: "msg you" },
      h("div", { class: "bubble", dir: "auto", text: ev.text }),
      ev.mode && ev.mode !== "auto" ? h("span", { class: "mode-badge", title: "Work mode for this task", text: ev.mode }) : null,
      files.length ? fileChips(files) : null,
      actions(clock(ev.t), [
        act("copy", "Copy", () => copyText(ev.text)),
        act("pen", "Edit", () => fillComposer(ev.text), "Put this text back in the task box"),
        act("retry", "Send again", () => sendTask(ev.text, files.map((f) => f.path))),
      ]));
  }
  function msgNote(ev) {
    return h("div", { class: "msg claude note" }, avatar(), h("div", { class: "body" }, h("div", { class: "card" }, mdBox(ev.text))));
  }
  const msgSys = (text) => h("div", { class: "msg sys", text });
  function msgFinal(ev, task, images) {
    if (ev.stopped) return msgSys(`You stopped this task · ${clock(ev.t)}`);
    const md = mdBox(ev.text || (ev.isError ? "Something went wrong." : "(no answer)"));
    const list = [act("copy", "Copy", () => copyText(ev.text))];
    if (!ev.isError) {
      list.push(act("speak", "Read aloud", (b) => speak(md.innerText, b)));
      list.push(act("bookmark", "Save", () => saveAnswer(ev.brain || "claude", ev.text, images)));
    }
    if (task) {
      list.push(act("retry", "Try again", () => sendTask(task.text, (task.files || []).map((f) => f.path)), "Send the same task again"));
      if (!ev.isError) list.push(act("users", "Second opinion", () => secondOpinion(task.text, ev.text), "Ask Gemini to check this answer"));
    }
    const took = ev.seconds != null ? ` · took ${dur(ev.seconds)}` : "";
    return h("div", { class: `msg claude${ev.isError ? " err" : ""}` }, avatar(),
      h("div", { class: "body" },
        h("div", { class: "who" }, h("b", { text: NAME[ev.brain] || "Claude" }), h("span", { text: `${clock(ev.t)}${took}` })),
        h("div", { class: "card" }, md, imgs(images)),
        actions("", list)));
  }

  // ---------- helper panels (left) ----------
  function addHelper(who, el) {
    const log = $(`#${who}-log`);
    if (!log) { addToThread(el); return; } // Claude as a helper (ChatGPT is the brain) has no panel: in the chat
    if (S.replaying) { log.append(el); return; }
    log.append(el);
    log.scrollTop = log.scrollHeight;
  }
  function onCall(ev) {
    const fromYou = ev.from === "you", asker = fromYou ? "You" : NAME[ev.from] || "Claude";
    S.stats.calls++;
    const text = h("div", { class: "hm-text", dir: "auto", text: ev.prompt });
    const ask = h("div", { class: `hm ask ${fromYou ? "from-you" : "from-claude"}` },
      h("div", { class: "hm-label" }, h("b", { text: asker }), h("span", { text: `to ${NAME[ev.to]} · ${clock(ev.t)}` })),
      h("div", { class: "hm-body" }, clampable(text, isLong(ev.prompt, 420, 7))));
    const reply = h("div", { class: "hm reply" }, h("div", { class: "hm-label" }, h("b", { text: NAME[ev.to] })), h("div", { class: "hm-body" }, typing()));
    addHelper(ev.to, ask);
    addHelper(ev.to, reply);
    pending.set(ev.id, { el: reply, who: ev.to, from: ev.from, t: ev.t });
    if (fromYou) noteTitle(ev.prompt);
    else addToThread(msgSys(/^Generate image:/.test(ev.prompt) ? `${asker} asked ${NAME[ev.to]} to make a picture` : `${asker} asked ${NAME[ev.to]} for help`));
    logLine(`${asker} → ${NAME[ev.to]}: ${short(ev.prompt, 70)}`, ev.to, ev.t);
    if (!S.replaying) { refreshCalling(); paintStats(); }
  }
  function onReply(ev) {
    const p = pending.get(ev.id);
    pending.delete(ev.id);
    let el = p?.el;
    if (!el) {
      el = h("div", { class: "hm reply" }, h("div", { class: "hm-label" }, h("b", { text: NAME[ev.to] })), h("div", { class: "hm-body" }));
      addHelper(ev.to, el);
    }
    const body = $(".hm-body", el);
    const text = String(ev.text || "");
    if (ev.stopped) {
      el.classList.add("muted");
      body.textContent = "Stopped.";
    } else if (ev.isError) {
      el.classList.add("err");
      body.textContent = text || "No answer.";
      el.append(actions(clock(ev.t), [act("copy", "Copy", () => copyText(text))]));
    } else {
      const images = ev.images || [];
      body.replaceChildren(...clampable(mdBox(text || "(empty reply)"), isLong(text, 900, 14)));
      const pics = imgs(images);
      if (pics) body.append(pics);
      for (const u of images) S.stats.images.add(u);
      if (p?.from && p.from !== "you") S.taskImages.push(...images);
      const secs = p?.t && ev.t ? Math.max(0, Math.round((ev.t - p.t) / 1000)) : null;
      el.append(actions(`${clock(ev.t)}${secs != null ? ` · ${dur(secs)}` : ""}`, [
        act("copy", "Copy", () => copyText(text)),
        act("up", "To the brain", () => fillComposer(`${NAME[ev.to]} said:\n\n${text.split("\n").map((l) => `> ${l}`).join("\n")}\n\n`, true), "Put this reply in the task box"),
        act("bookmark", "Save", () => saveAnswer(ev.to, text, images)),
      ]));
    }
    logLine(ev.stopped ? `${NAME[ev.to]}: stopped` : ev.isError ? `${NAME[ev.to]} failed: ${short(text, 80)}` : `${NAME[ev.to]} answered`, ev.isError ? "error" : ev.to, ev.t);
    if (!S.replaying) {
      const log = $(`#${ev.to}-log`);
      if (log) log.scrollTop = log.scrollHeight;
      refreshCalling();
      paintStats();
      if (ev.id === S.studioId) studioDone(ev);
      if (ev.video && video.waiting && (ev.id === video.id || (!video.id && String(ev.id).startsWith("direct-")))) videoDone(ev);
    }
  }
  function onReplyCancel(ev) {
    const p = pending.get(ev.id);
    pending.delete(ev.id);
    if (p) {
      p.el.classList.add("muted");
      $(".hm-body", p.el).textContent = "No answer – the task ended first.";
    }
    if (!S.replaying) refreshCalling();
  }
  const waitingOn = (who) => [...pending.values()].some((p) => p.who === who);
  function refreshCalling() {
    for (const who of HELPERS) {
      const on = waitingOn(who);
      $(`#p-${who}`).classList.toggle("calling", on);
      window.Station?.helperBusy?.(who, on);
    }
    paintDots();
    paintStage();
  }
  function paintDirect() {
    for (const who of HELPERS) {
      const btn = $(`.p-form[data-who="${who}"] button[type="submit"]`);
      const on = !!S.direct[who];
      btn.classList.toggle("stop", on);
      btn.replaceChildren(icon(on ? "stop" : "send"));
      btn.title = on ? "Stop" : "Send";
      btn.setAttribute("aria-label", on ? `Stop ${NAME[who]}` : `Send to ${NAME[who]}`);
    }
    paintSend();
    studioPaint();
  }
  for (const form of $$(".p-form")) {
    const who = form.dataset.who, ta = $("textarea", form);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (S.direct[who]) { await tryApi("/api/ask/stop", { to: who }); return; }
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      if (await tryApi("/api/ask", { to: who, text })) { ta.value = ""; grow(ta); }
    });
    ta.addEventListener("input", () => grow(ta));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    });
  }
  $('[data-act="studio"]').addEventListener("click", () => openStudio("picture"));
  for (const b of $$('[data-act="max"]')) b.addEventListener("click", () => toggleMax(b.closest(".panel")));
  function toggleMax(panel, force) {
    const on = force ?? !panel.classList.contains("max");
    for (const p of $$(".panel.max")) p.classList.remove("max");
    panel.classList.toggle("max", on);
    const b = $('[data-act="max"]', panel);
    if (b) { b.classList.toggle("on", on); b.title = on ? "Back to normal size (Esc)" : "Make this panel bigger"; }
  }

  // ---------- activity, stats, queue (right) ----------
  const logEl = $("#log");
  function logLine(text, cls = "", t) {
    const el = h("div", { class: `log-line ${cls}` }, h("time", { text: clock(t) }), h("span", { text }));
    if (S.replaying) { logEl.append(el); return; }
    const stick = atBottom(logEl);
    logEl.append(el);
    while (logEl.children.length > 400) logEl.firstChild.remove();
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  }
  $("#btn-log-clear").addEventListener("click", () => logEl.replaceChildren());
  function paintStats() {
    const st = S.stats;
    $("#st-tasks").textContent = st.tasks;
    $("#st-calls").textContent = st.calls;
    $("#st-images").textContent = st.images.size;
    $("#st-avg").textContent = st.secs.length ? dur(Math.round(st.secs.reduce((a, b) => a + b, 0) / st.secs.length)) : "–";
  }
  function paintQueue() {
    const items = S.queue || [];
    $("#queue-panel").hidden = !items.length;
    $("#queue-count").textContent = items.length;
    $("#queue").replaceChildren(...items.map((q, i) => h("div", { class: "q-item", title: q.text },
      h("span", { text: `${i + 1}. ${short(q.text, 120)}` }),
      h("button", { class: "icon-btn danger", type: "button", title: "Remove from the list", "aria-label": "Remove from the list", onclick: () => tryApi("/api/queue/remove", { id: q.id }) }, icon("x")))));
    paintStage();
  }

  // ---------- brain stage ----------
  const PHASES = { idle: "Ready", starting: "Waking up…", thinking: "Thinking…", writing: "Writing the answer…", helpers: "Asking the helpers…" };
  function phaseText() {
    if (!S.busy) return "Ready";
    if (S.phase === "helpers") {
      const who = [...new Set([...pending.values()].filter((p) => p.from !== "you").map((p) => NAME[p.who]))];
      if (who.length) return `Asking ${who.join(" and ")}…`;
    }
    return S.phase === "idle" ? "Working…" : PHASES[S.phase] || "Working…";
  }
  function paintStage() {
    const label = phaseText();
    $("#phase-label").textContent = label;
    const secs = S.busy && S.taskStart ? Math.max(0, Math.round((Date.now() - S.taskStart) / 1000)) : 0;
    if (livePhase) livePhase.textContent = S.busy ? `${label} ${mmss(secs)}` : label;
    const sub = $("#stage-sub");
    if (S.busy) sub.textContent = `Working for ${mmss(secs)}${S.queue.length ? ` · ${S.queue.length} waiting` : ""}`;
    else if (S.direct.gemini || S.direct.chatgpt) sub.textContent = `Waiting for ${HELPERS.filter((w) => S.direct[w]).map((w) => NAME[w]).join(" and ")} (direct message)`;
    else if (S.settings) sub.textContent = `${brainId() === "chatgpt" ? "Brain: ChatGPT" : `Model: ${MODEL[S.settings.brainModel] || S.settings.brainModel}`} · Effort: ${S.settings.effort === "auto" ? "automatic" : S.settings.effort}`;
  }
  setInterval(() => { if (S.busy) paintStage(); }, 1000);
  function paintSend() {
    $("#send-label").textContent = S.busy || S.direct.gemini || S.direct.chatgpt ? "Queue" : "Send";
  }
  function setBusy(v) {
    S.busy = !!v;
    $("#emblem").classList.toggle("working", S.busy);
    $("#btn-stop").hidden = !S.busy;
    if (S.busy) ensureLive(); else dropLive();
    paintSend();
    paintDots();
    paintStage();
    fxKick();
  }
  $("#btn-stop").addEventListener("click", () => tryApi("/api/stop"));

  // ---------- usage, sign-in status ----------
  function paintUsage(u) {
    S.usage = u;
    const tips = [];
    for (const [key, id, label] of [["five_hour", "5h", "5-hour limit"], ["seven_day", "7d", "Weekly limit"]]) {
      const v = u?.[key];
      const num = $(`#usage-${id}`), bar = $(`#usage-${id}-bar`);
      if (v == null) { num.textContent = "–"; bar.style.width = "0"; continue; }
      const pct = Math.max(0, Math.min(100, v <= 1 ? v * 100 : v));
      num.textContent = `${Math.round(pct)}%`;
      bar.style.width = `${pct}%`;
      bar.className = pct >= 90 ? "bad" : pct >= 70 ? "warn" : "";
      const r = u[`${key}_resets`];
      let when = "";
      if (r) {
        const d = new Date(r * 1000), same = d.toDateString() === new Date().toDateString();
        when = `, resets ${same ? "at " : ""}${d.toLocaleString([], same ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" })}`;
      }
      tips.push(`${label}: ${Math.round(pct)}% used${when}`);
    }
    $("#usage").title = tips.length ? `Your Claude plan\n${tips.join("\n")}` : "How much of your Claude plan limit is used. Appears after a task Claude did.";
  }
  function paintDots() {
    for (const who of ["claude", ...HELPERS]) {
      const st = S.status?.[who];
      const busy = who === brainId() ? S.busy || waitingOn(who) : waitingOn(who);
      const cls = busy ? "busy" : !st || st.off ? "" : st.ok ? "ok" : "bad";
      const dots = [$(`#chips .chip[data-who="${who}"] .dot`), $(`#${who}-dot`)];
      for (const d of dots) if (d) d.className = `dot ${cls}`;
    }
  }
  function paintStatus() {
    const st = S.status, on = !!S.settings?.chatgptEnabled, gpt = brainId() === "chatgpt";
    $("#p-chatgpt").classList.toggle("off", !on);
    window.Station?.chatgpt?.(on);
    $("#chips .chip[data-who='chatgpt']").hidden = !on && !gpt;
    $("#empty-sub").textContent = gpt
      ? "Type a task below. ChatGPT is the brain: it plans it, asks Claude and Gemini for help when it is useful, and gives you one answer."
      : on
        ? "Type a task below. Claude plans it, asks ChatGPT and Gemini for help when it is useful, and gives you one answer."
        : "Type a task below. Claude plans it, asks Gemini for help when it is useful, and gives you one answer.";
    $("#set-chatgpt-state").textContent = !on ? "Off" : st?.chatgpt && !st.chatgpt.off ? st.chatgpt.detail : "Checking…";
    $("#row-chatgpt-login").hidden = !(on && st?.chatgpt && !st.chatgpt.off && !st.chatgpt.ok);
    $("#chatgpt-detail").textContent = !on ? "Switched off" : st?.chatgpt && !st.chatgpt.off ? st.chatgpt.detail : "Checking…";
    if (st) {
      const gm = S.settings?.geminiModel && S.settings.geminiModel !== "auto" ? ` · ${S.settings.geminiModel}` : "";
      $("#gemini-detail").textContent = `${st.gemini.detail}${gm}`;
      for (const who of ["claude", ...HELPERS]) {
        const chip = $(`#chips .chip[data-who="${who}"]`);
        chip.title = `${NAME[who]}: ${st[who].detail}`;
      }
      const a = st.about || {};
      $("#about").textContent = `AI Brain ${a.version || ""} · Node ${a.node || ""} · Data folder: ${a.dataDir || ""}${a.test ? " · TEST MODE (not the real Claude)" : ""}`;
    }
    paintDots();
  }
  async function refreshStatus(force) {
    try { S.status = await api(`/api/status${force ? "?force=1" : ""}`); } catch { return; }
    paintStatus();
  }
  setInterval(() => { if (!document.hidden && !S.closing) refreshStatus(); }, 60_000);
  for (const chip of $$("#chips .chip")) chip.addEventListener("click", async () => {
    await refreshStatus(true);
    const who = chip.dataset.who, st = S.status?.[who];
    if (st) toast(`${NAME[who]}: ${st.detail}`, st.ok ? "ok" : st.off ? "" : "err");
  });

  // ---------- wires between the helpers and the brain ----------

  // ---------- settings ----------
  function applySettings(s) {
    if (!s) return;
    const stick = atBottom(thread);
    const themeChanged = S.settings?.theme !== s.theme;
    S.settings = s;
    root.dataset.theme = s.theme;
    root.dataset.accent = s.accent || "blue";
    root.dataset.density = s.density || "compact";
    store.set("theme", s.theme);
    root.classList.toggle("no-anim", !s.animations);
    root.style.setProperty("--fs", `${s.fontSize}px`);
    root.style.setProperty("--dim", String(s.bgDim / 100));
    const bg = $("#bg-custom");
    bg.classList.toggle("on", !!s.customBg);
    bg.style.backgroundImage = s.customBg ? `url("/custom/${encodeURIComponent(s.customBg)}")` : "";
    const active = document.activeElement;
    for (const r of $$('input[name="theme"]')) r.checked = r.value === s.theme;
    $("#set-anim").checked = !!s.animations;
    if (active !== $("#set-font")) $("#set-font").value = s.fontSize;
    $("#set-font-val").textContent = `${s.fontSize} px`;
    $("#set-bg-state").textContent = s.customBg ? "Your own picture is in use" : "None";
    $("#set-bg-remove").hidden = !s.customBg;
    $("#row-dim").hidden = !s.customBg;
    if (active !== $("#set-dim")) $("#set-dim").value = s.bgDim;
    $("#set-dim-val").textContent = `${s.bgDim}%`;
    $("#set-brain").value = s.brain === "chatgpt" ? "chatgpt" : "claude";
    $("#set-brain-note").textContent = s.brain === "chatgpt"
      ? "ChatGPT plans every task and uses your ChatGPT plan. Claude and Gemini are its helpers."
      : "Claude plans every task and uses your Claude plan. ChatGPT and Gemini are its helpers.";
    $("#set-model").value = s.brainModel;
    $("#set-effort").value = s.effort;
    $("#set-memory").value = String(s.memoryLimit ?? 100);
    fillGeminiModels();
    $("#set-chatgpt").checked = !!s.chatgptEnabled;
    $("#set-flow-brain").checked = !!s.flowBrain;
    $("#set-apps-brain").checked = !!s.appsBrain;
    $("#set-inspect-brain").checked = !!s.inspectBrain;
    $("#set-sounds").checked = !!s.sounds;
    $("#set-notify").checked = !!s.notify;
    for (const r of $$('input[name="accent"]')) r.checked = r.value === s.accent;
    $("#set-density").checked = s.density === "cozy";
    $("#set-clock24").checked = s.clock24 !== false;
    $("#set-style").value = s.answerStyle || "auto";
    paintAccess(s);
    paintVideo();
    if (active !== $("#set-instructions")) $("#set-instructions").value = s.instructions || "";
    window.Station?.settings?.(s);
    paintStatus();
    paintStage();
    if (themeChanged) fxColors();
    if (stick) requestAnimationFrame(scrollDown);
    fxKick();
  }
  async function saveSetting(patch) {
    const s = await tryApi("/api/settings", patch);
    if (s) {
      applySettings(s);
      // The server refused a choice (an older server still running in the background does not know newer choices).
      const refused = Object.keys(patch).filter((k) => (typeof patch[k] === "boolean" || ["theme", "access", "accent", "density"].includes(k)) && s[k] !== patch[k]);
      if (refused.length) toast("That setting was not saved. Close AI Brain completely and open it again, then try once more.", "err", 8000);
    }
    return s;
  }
  let geminiModels = null;
  function fillGeminiModels() {
    const sel = $("#set-gemini-model"), cur = S.settings?.geminiModel || "auto";
    const list = [{ id: "auto", label: "Automatic" }, ...(geminiModels || [])];
    if (!list.some((m) => m.id === cur)) list.push({ id: cur, label: cur });
    sel.replaceChildren(...list.map((m) => h("option", { value: m.id, text: m.label })));
    sel.value = cur;
  }
  async function openSettings() {
    openDlg("#dlg-settings");
    refreshStatus(true);
    loadVideoInfo();
    if (!geminiModels) {
      try { geminiModels = await api("/api/gemini-models"); fillGeminiModels(); } catch { /* the list stays on Automatic */ }
    }
  }
  for (const r of $$('input[name="theme"]')) r.addEventListener("change", () => saveSetting({ theme: r.value }));
  $("#set-anim").addEventListener("change", (e) => saveSetting({ animations: e.target.checked }));
  $("#set-font").addEventListener("input", (e) => { root.style.setProperty("--fs", `${e.target.value}px`); $("#set-font-val").textContent = `${e.target.value} px`; });
  $("#set-font").addEventListener("change", (e) => saveSetting({ fontSize: Number(e.target.value) }));
  $("#set-dim").addEventListener("input", (e) => { root.style.setProperty("--dim", String(e.target.value / 100)); $("#set-dim-val").textContent = `${e.target.value}%`; });
  $("#set-dim").addEventListener("change", (e) => saveSetting({ bgDim: Number(e.target.value) }));
  $("#set-brain").addEventListener("change", async (e) => { await saveSetting({ brain: e.target.value }); refreshStatus(true); });
  $("#set-model").addEventListener("change", (e) => saveSetting({ brainModel: e.target.value }));
  $("#set-effort").addEventListener("change", (e) => saveSetting({ effort: e.target.value }));
  $("#set-memory").addEventListener("change", (e) => saveSetting({ memoryLimit: Number(e.target.value) }));
  $("#set-gemini-model").addEventListener("change", (e) => saveSetting({ geminiModel: e.target.value }));
  $("#set-sounds").addEventListener("change", (e) => { saveSetting({ sounds: e.target.checked }); if (e.target.checked) { S.settings.sounds = true; chime(true); } });
  $("#set-chatgpt").addEventListener("change", async (e) => { await saveSetting({ chatgptEnabled: e.target.checked }); refreshStatus(true); });
  $("#set-flow-brain").addEventListener("change", (e) => saveSetting({ flowBrain: e.target.checked }));
  $("#set-apps-brain").addEventListener("change", (e) => saveSetting({ appsBrain: e.target.checked }));
  $("#set-inspect-brain").addEventListener("change", (e) => saveSetting({ inspectBrain: e.target.checked }));

  // ---------- web inspector: the AI Brain extension in the user's own browser ----------
  function paintInspect(v) {
    if (!v) return;
    $("#set-inspect-folder").textContent = v.folder || "";
    const tabs = v.tabs || [];
    $("#set-inspect-state").textContent = !v.paired ? "Not set up yet. Follow the steps below."
      : !v.connected ? "Paired, but the extension is not connected now. Open your browser to connect it."
      : `Connected${v.browser ? ` (${v.browser})` : ""}. ${tabs.length ? `Shared: ${tabs.map((t) => t.title || t.url).slice(0, 3).join(", ")}${tabs.length > 3 ? ` and ${tabs.length - 3} more` : ""}` : "No tab is shared yet."}`;
  }
  async function loadInspect() { try { paintInspect(await api("/api/inspect")); } catch { /* shown next time */ } }
  async function showInspectCode(renew) {
    const r = await tryApi("/api/inspect/code", { renew });
    if (!r?.code) return;
    $("#set-inspect-code").textContent = r.code;
    $("#set-inspect-code").hidden = $("#set-inspect-copy").hidden = $("#set-inspect-renew").hidden = false;
    $("#set-inspect-show").hidden = true;
    paintInspect(r);
    if (renew) toast("New pairing code. Paste it in the extension again.", "ok");
  }
  $("#set-inspect-show").addEventListener("click", () => showInspectCode(false));
  $("#set-inspect-renew").addEventListener("click", () => showInspectCode(true));
  $("#set-inspect-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#set-inspect-code").textContent); toast("Pairing code copied.", "ok"); } catch { toast("Could not copy. Select the code and copy it.", "err"); }
  });
  loadInspect();
  $("#set-video-model").addEventListener("change", (e) => saveSetting({ videoModel: e.target.value }));
  $("#set-video-limit").addEventListener("change", (e) => {
    const n = Math.round(Number(e.target.value));
    if (!Number.isFinite(n) || n < 0 || n > 200) { e.target.value = S.settings?.videoDailyLimit ?? 10; toast("Pick a number from 0 to 200.", "err"); return; }
    saveSetting({ videoDailyLimit: n });
  });
  async function saveVideoKey() {
    const box = $("#set-video-key"), key = box.value.trim();
    if (!key) { toast("Paste your Google API key first."); box.focus(); return; }
    const btn = $("#set-video-save");
    btn.disabled = true;
    $("#set-video-state").textContent = "Checking the key with Google…";
    const r = await tryApi("/api/google-key", { key });
    btn.disabled = false;
    if (r) { box.value = ""; video.info = r; toast("Video is connected.", "ok"); refreshStatus(true); }
    paintVideo();
  }
  $("#set-video-save").addEventListener("click", saveVideoKey);
  $("#set-video-key").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveVideoKey(); } });
  $("#set-video-remove").addEventListener("click", async () => {
    if (!await confirmBox("Remove the Google key?", "Video will be switched off until you add a key again. Videos you already made stay in your Gallery.", { yes: "Remove", danger: true })) return;
    const r = await tryApi("/api/google-key", { remove: true });
    if (r) { video.info = r; toast("The Google key was removed.", "ok"); refreshStatus(true); }
    paintVideo();
  });
  $("#set-chatgpt-login").addEventListener("click", async () => {
    if (await tryApi("/api/login/chatgpt")) toast("A sign-in window opened. Finish there, then come back here.", "ok", 7000);
  });
  $("#set-notify").addEventListener("change", async (e) => {
    if (e.target.checked) {
      let perm = "denied";
      try { perm = "Notification" in window ? await Notification.requestPermission() : "denied"; } catch { /* blocked */ }
      if (perm !== "granted") { e.target.checked = false; toast("Notifications are blocked for this app in your browser.", "err"); return; }
    }
    saveSetting({ notify: e.target.checked });
  });
  // A background bigger than the screen only costs: an 8K picture takes about 130 MB once opened and is
  // scaled again on every window resize. Bigger pictures are made screen-sized (as JPG) before upload.
  async function shrinkBackground(file) {
    const most = Math.min(3840, Math.max(2560, Math.round(screen.width * (window.devicePixelRatio || 1))));
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { return { blob: file, name: file.name }; }
    const k = most / Math.max(bmp.width, bmp.height * 16 / 9);
    if (k >= 1) { bmp.close(); return { blob: file, name: file.name }; }
    const cv = document.createElement("canvas");
    cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    const ctx = cv.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close();
    const blob = await new Promise((ok) => cv.toBlob(ok, "image/jpeg", 0.9));
    return blob ? { blob, name: file.name.replace(/\.[^.]*$/, "") + ".jpg" } : { blob: file, name: file.name };
  }
  $("#set-bg-pick").addEventListener("click", () => $("#set-bg-file").click());
  $("#set-bg-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { toast("That picture is too large (limit 20 MB).", "err"); return; }
    try {
      const { blob, name } = await shrinkBackground(file);
      const res = await fetch(`/api/background?name=${encodeURIComponent(name)}`, { method: "POST", body: blob });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not use that picture.");
      applySettings(data);
      toast("Background changed.", "ok");
    } catch (err) { toast(err.message || "Could not use that picture.", "err"); }
  });
  $("#set-bg-remove").addEventListener("click", () => saveSetting({ customBg: null }));
  for (const r of $$('input[name="accent"]')) r.addEventListener("change", () => saveSetting({ accent: r.value }));
  $("#set-density").addEventListener("change", (e) => saveSetting({ density: e.target.checked ? "cozy" : "compact" }));
  $("#set-clock24").addEventListener("change", (e) => saveSetting({ clock24: e.target.checked }));
  $("#set-style").addEventListener("change", (e) => saveSetting({ answerStyle: e.target.value }));
  // File and command access: "read" (default), "ask" (Claude may change things after your click)
  // or "auto" (always allow: nothing waits for a click).
  function paintAccess(s) {
    const mode = ["ask", "auto"].includes(s.access) ? s.access : "read";
    $("#set-access").value = mode;
    const who = brainName();
    $("#set-access-note").textContent = mode === "auto"
      ? `Always allow: ${who} writes files and runs commands without asking. Everything it does is listed in Activity.`
      : mode === "ask" ? `${who} may write files and run commands. Every change waits for your Allow.`
      : `Read only: ${who} can read files but not change anything`;
    $("#row-folders").hidden = mode === "read";
    $("#set-folders-note").textContent = mode === "auto"
      ? "Besides its own workspace. Commands can reach other places too."
      : "Besides its own workspace. Each change still needs your click. Commands can reach other places, but you see every one first.";
    const sb = $("#sb-access");
    sb.hidden = mode === "read";
    sb.textContent = mode === "auto" ? "Always allow" : "Asks first";
    sb.classList.toggle("warn", mode === "auto");
    sb.title = mode === "auto" ? `${who} changes files and runs commands without asking. Click to change this in Settings.` : `${who} asks before every change. Click to change this in Settings.`;
    const list = $("#set-folders");
    list.replaceChildren(...(s.folders || []).map((f) => h("li", {},
      h("code", { text: f, title: f }),
      h("button", { class: "icon-btn", "aria-label": `Remove ${f}`, title: "Remove", onclick: () => saveSetting({ folders: (S.settings.folders || []).filter((x) => x !== f) }) }, svgUse("i-x", "i")))));
    if (!s.folders?.length) list.append(h("li", { class: "empty", text: "Only its own workspace folder." }));
  }
  $("#set-access").addEventListener("change", async (e) => {
    const was = S.settings?.access || "read";
    if (e.target.value === "ask" && was === "read" && !await confirmBox(`Let ${brainName()} change files and run commands?`,
      `${brainName()} will be able to write and edit files and run PowerShell commands. AI Brain shows you every change and every command first, and nothing happens until you click Allow. You can switch this back to Read only at any time.`,
      { yes: "Turn on" })) { e.target.value = was; return; }
    if (e.target.value === "auto" && !await confirmAlways()) { e.target.value = was; return; }
    saveSetting({ access: e.target.value });
  });
  const confirmAlways = () => confirmBox("Always allow, without asking?",
    `${brainName()} will write and edit files and run PowerShell commands right away, with no Allow or Deny question. You can still see everything it does in the Activity panel, and Stop still works. Sign-in data and Discord's data stay off limits. You can switch this back in Settings at any time.`,
    { yes: "Always allow" });
  $("#sb-access").addEventListener("click", () => openSettings());
  // "Always allow" in the question itself: switch the setting; the server then lets the waiting ones through.
  $("#ap-always").addEventListener("click", async () => {
    if (!await confirmAlways()) return;
    try { applySettings(await api("/api/settings", { access: "auto" })); toast(`Always allow is on. ${brainName()} will not ask again.`, "ok"); }
    catch (err) { toast(err.message, "err"); }
  });
  $("#set-folder-add").addEventListener("click", async () => {
    const f = await askInput(`Folder ${brainName()} may work in (full path)`, "", { max: 260, placeholder: "C:\\Users\\you\\Documents\\my-project" });
    if (!f) return;
    try { applySettings(await api("/api/settings", { folders: [...(S.settings.folders || []), f.replace(/^"+|"+$/g, "")] })); toast("Folder added.", "ok"); }
    catch (err) { toast(err.message, "err"); }
  });
  $("#set-instructions").addEventListener("change", (e) => saveSetting({ instructions: e.target.value.slice(0, 2000) }));
  $("#set-layout-reset").addEventListener("click", () => { window.Station?.preset("station"); toast("The layout is back to the Station preset.", "ok"); });
  window.addEventListener("focus", () => { if (S.settings?.chatgptEnabled && S.status && !S.status.chatgpt?.ok) refreshStatus(true); });

  // ---------- floating sparks ----------
  const fx = { cv: $("#fx"), ctx: null, parts: [], raf: 0, last: 0, c1: "233, 190, 96", c2: "214, 52, 76", w: 0, h: 0 };
  fx.ctx = fx.cv.getContext("2d");
  function fxColors() {
    const cs = getComputedStyle(root);
    fx.c1 = cs.getPropertyValue("--fx1").trim() || fx.c1;
    fx.c2 = cs.getPropertyValue("--fx2").trim() || fx.c2;
    const dir = cs.getPropertyValue("--fx-dir").trim();
    if (dir !== fx.dir) { fx.dir = dir; fx.parts = fx.parts.map(() => fxNew(true)); }
  }
  function fxSize() {
    fx.w = window.innerWidth; fx.h = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    fx.cv.width = Math.round(fx.w * dpr); fx.cv.height = Math.round(fx.h * dpr);
    fx.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const want = Math.max(18, Math.min(70, Math.round((fx.w * fx.h) / 30000)));
    while (fx.parts.length < want) fx.parts.push(fxNew(true));
    fx.parts.length = want;
  }
  function fxNew(anywhere) {
    return {
      x: anywhere || fx.dir !== "side" ? Math.random() * fx.w : -10,
      y: anywhere || fx.dir === "side" ? Math.random() * fx.h : fx.dir === "down" ? -10 : fx.h + 10,
      r: 0.6 + Math.random() * 1.7, vy: 6 + Math.random() * 18, sway: Math.random() * 6.28,
      a: 0.15 + Math.random() * 0.5, two: Math.random() < 0.22,
    };
  }
  function fxFrame(now) {
    fx.raf = 0;
    if (!fxWanted()) { if (!fxOn()) fx.ctx.clearRect(0, 0, fx.w, fx.h); return; } // unfocused: they just stand still
    fx.raf = requestAnimationFrame(fxFrame);
    // Hold still while a panel or line is being dragged (the frame is busy enough then).
    if (document.body.classList.contains("dragging")) { fx.last = now; return; }
    const dt = Math.min(0.1, (now - fx.last) / 1000);
    if (dt < 0.04) return; // about 25 drawings a second is plenty for slow sparks
    fx.last = now;
    const speed = S.busy ? 2.2 : 1, ctx = fx.ctx;
    ctx.clearRect(0, 0, fx.w, fx.h);
    for (let i = 0; i < fx.parts.length; i++) {
      const p = fx.parts[i];
      p.sway += dt;
      if (fx.dir === "down") { p.y += p.vy * 0.55 * dt * speed; p.x += Math.sin(p.sway * 0.8) * 14 * dt; }
      else if (fx.dir === "side") { p.x += p.vy * 1.6 * dt * speed; p.y += Math.sin(p.sway) * 10 * dt; }
      else { p.y -= p.vy * dt * speed; p.x += Math.sin(p.sway) * 6 * dt; }
      if (p.y < -10 || p.y > fx.h + 10 || p.x > fx.w + 10) { fx.parts[i] = fxNew(false); continue; }
      const tw = p.a * (0.7 + 0.3 * Math.sin(p.sway * 2.3));
      const col = p.two ? fx.c2 : fx.c1;
      ctx.fillStyle = `rgba(${col}, ${(tw * 0.22).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r * 3.2, 0, 6.2832); ctx.fill();
      ctx.fillStyle = `rgba(${col}, ${tw.toFixed(3)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.fill();
    }
  }
  // Only while AI Brain is the window in use: when you work in the program in the middle (or
  // anywhere else), the sparks stop and leave the graphics card to it.
  const fxOn = () => !!S.settings?.animations && S.settings.theme !== "dark" && !S.closing;
  const fxWanted = () => fxOn() && !document.hidden && document.hasFocus();
  function fxKick() {
    if (fxWanted()) { if (!fx.raf) { fx.last = performance.now(); fx.raf = requestAnimationFrame(fxFrame); } }
    else if (!fx.raf && !fxOn()) fx.ctx.clearRect(0, 0, fx.w, fx.h);
  }
  window.addEventListener("resize", fxSize);
  window.addEventListener("focus", fxKick);
  window.addEventListener("blur", fxKick);
  document.addEventListener("visibilitychange", () => { fxKick(); if (!document.hidden) document.title = pageTitle(); });

  // ---------- sound, notification ----------
  let actx = null;
  function chime(ok) {
    if (!S.settings?.sounds) return;
    try {
      actx = actx || new AudioContext();
      if (actx.state === "suspended") actx.resume();
      const now = actx.currentTime;
      (ok ? [659.25, 987.77] : [311.13, 233.08]).forEach((f, i) => {
        const o = actx.createOscillator(), g = actx.createGain(), t0 = now + i * 0.15;
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.09, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
        o.connect(g).connect(actx.destination);
        o.start(t0); o.stop(t0 + 0.6);
      });
    } catch { /* no audio device */ }
  }
  function announce(ev) {
    if (ev.stopped) return;
    chime(!ev.isError);
    if (!document.hidden) return;
    document.title = `${ev.isError ? "⚠ Problem" : "✓ Done"} – AI Brain`;
    if (S.settings?.notify && "Notification" in window && Notification.permission === "granted") {
      try {
        const n = new Notification(ev.isError ? "AI Brain: the task had a problem" : "AI Brain: your answer is ready", { body: short(ev.text, 140), icon: "icon.svg", tag: "ai-brain" });
        n.onclick = () => { window.focus(); n.close(); };
      } catch { /* notifications unavailable */ }
    }
  }
  let speaking = null;
  function stopSpeak(ended) {
    if (!ended) { try { speechSynthesis.cancel(); } catch { /* nothing to cancel */ } }
    if (speaking) setAct(speaking, "speak", "Read aloud");
    speaking = null;
  }
  function speak(text, btn) {
    if (!("speechSynthesis" in window)) { toast("Reading aloud is not available in this browser.", "err"); return; }
    const same = speaking === btn;
    stopSpeak();
    if (same) return;
    const u = new SpeechSynthesisUtterance(String(text).slice(0, 8000));
    if (/[؀-ۿ]/.test(text)) u.lang = "ar";
    u.onend = u.onerror = () => { if (speaking === btn) stopSpeak(true); };
    speaking = btn;
    setAct(btn, "stop", "Stop reading");
    speechSynthesis.speak(u);
  }

  // ---------- composer ----------
  const taskEl = $("#task");
  function grow(ta) { ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight + 2}px`; }
  function fillComposer(text, append) {
    for (const d of [...dlgStack]) if (!["dlg-confirm", "dlg-input"].includes(d.id)) d.close();
    taskEl.value = append && taskEl.value.trim() ? `${taskEl.value.replace(/\s+$/, "")}\n\n${text}` : text;
    grow(taskEl);
    store.set("draft", taskEl.value);
    taskEl.focus();
    taskEl.setSelectionRange(taskEl.value.length, taskEl.value.length);
    taskEl.scrollTop = taskEl.scrollHeight;
  }
  let histIdx = -1;
  function pushHistory(text) {
    const t = text.trim();
    if (!t) return;
    S.history = [t, ...S.history.filter((x) => x !== t)].slice(0, 50);
    store.set("history", S.history);
    histIdx = -1;
  }
  let draftTimer = null;
  taskEl.addEventListener("input", () => {
    grow(taskEl);
    histIdx = -1;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => store.set("draft", taskEl.value), 300);
  });
  taskEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); return; }
    const browsing = histIdx >= 0 && taskEl.value === S.history[histIdx];
    if (e.key === "ArrowUp" && (taskEl.value === "" || browsing) && histIdx < S.history.length - 1) {
      e.preventDefault(); histIdx++; taskEl.value = S.history[histIdx]; grow(taskEl);
    } else if (e.key === "ArrowDown" && browsing) {
      e.preventDefault(); histIdx--; taskEl.value = histIdx >= 0 ? S.history[histIdx] : ""; grow(taskEl);
    }
  });
  taskEl.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  let attachSeq = 0;
  function paintAttach() {
    $("#attachments").replaceChildren(...S.attach.map((a) => h("span", { class: `file-chip${a.loading ? " loading" : ""}`, title: a.name },
      a.url ? h("img", { src: a.url, alt: "" }) : icon("clip"),
      h("span", { text: a.loading ? `${a.name} (uploading…)` : a.name }),
      h("button", { type: "button", title: "Remove", "aria-label": `Remove ${a.name}`, onclick: () => { S.attach = S.attach.filter((x) => x !== a); paintAttach(); } }, icon("x")))));
  }
  async function addFiles(files) {
    for (const file of files) {
      if (S.attach.length >= 20) { toast("You can attach up to 20 files.", "err"); break; }
      if (file.size > 30 * 1024 * 1024) { toast(`${file.name} is too large (limit 30 MB).`, "err"); continue; }
      const a = { id: ++attachSeq, name: file.name || "file", loading: true, path: null, url: null };
      S.attach.push(a);
      paintAttach();
      try {
        const res = await fetch(`/api/upload?name=${encodeURIComponent(a.name)}`, { method: "POST", body: file });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed.");
        Object.assign(a, { loading: false, path: data.path, url: data.url, name: data.name || a.name });
      } catch (err) {
        S.attach = S.attach.filter((x) => x !== a);
        toast(`${a.name}: ${err.message || "upload failed"}`, "err");
      }
      paintAttach();
    }
  }
  function attachExisting(it) {
    if (!it.path) { toast("That picture cannot be attached.", "err"); return; }
    if (!S.attach.some((a) => a.path === it.path)) S.attach.push({ id: ++attachSeq, name: it.name, path: it.path, url: it.url, loading: false });
    paintAttach();
    for (const d of [...dlgStack]) d.close();
    taskEl.focus();
    toast("Attached to your next task.", "ok", 2200);
  }
  $("#btn-attach").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (e) => { addFiles([...e.target.files]); e.target.value = ""; });

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; $("#drop").hidden = false; } });
  window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener("dragleave", (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; $("#drop").hidden = true; } });
  window.addEventListener("drop", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $("#drop").hidden = true;
    addFiles([...e.dataTransfer.files]);
  });

  async function sendTask(text, files = []) {
    const r = await tryApi("/api/task", { text, files: files.filter(Boolean), mode: window.Station?.currentMode?.() || "auto" });
    if (!r) return false;
    pushHistory(text);
    if (r.queued) toast("Added to the waiting list. It runs as soon as the brain is free.", "ok");
    return true;
  }
  let sending = false;
  $("#composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (sending) return;
    if (S.attach.some((a) => a.loading)) { toast("Wait for the files to finish uploading."); return; }
    let text = taskEl.value.trim();
    if (!text && S.attach.length) text = "Look at the attached files and tell me what you see.";
    if (!text) { toast("Type a task first."); taskEl.focus(); return; }
    sending = true;
    $("#btn-send").disabled = true;
    const ok = await sendTask(text, S.attach.map((a) => a.path));
    sending = false;
    $("#btn-send").disabled = false;
    if (!ok) return;
    taskEl.value = "";
    grow(taskEl);
    store.set("draft", "");
    S.attach = [];
    paintAttach();
    taskEl.focus();
  });
  async function secondOpinion(question, answer) {
    const text = `Please check this answer and give a short second opinion. Point out mistakes and anything important that is missing.\n\nQuestion:\n${question}\n\nAnswer:\n${answer}`;
    if (await tryApi("/api/ask", { to: "gemini", text })) toast("Asked Gemini. Its reply appears in the Gemini panel.", "ok");
  }
  async function saveAnswer(who, text, images) {
    if (await tryApi("/api/saved/add", { who, text, images: images || [] })) toast("Saved. Find it under Saved answers.", "ok");
  }

  const IDEAS = [
    ["bars", "Plan something", "Plan a one-week launch for my coffee shop “Byte Brew”, and ask Gemini for five slogan ideas."],
    ["image", "Make a picture", "Create a logo for a coffee shop called “Byte Brew”: a steaming cup built from pixels, gold on black."],
    ["film", "Make a video", "Make a 4-second video: steam rising from a coffee cup on a dark wooden table, slow camera push-in."],
    ["users", "Get a second opinion", "Explain how to start saving money on a small income, then have Gemini check your advice."],
    ["code", "Fix some code", "Find the bug in this code and explain the fix in plain words:\n\n"],
    ["book", "Learn something", "Teach me how photosynthesis works in simple steps, then quiz me with five questions."],
  ];
  $("#ideas").replaceChildren(...IDEAS.map(([ic, t, d]) => h("button", { class: "idea", type: "button", "data-idea": ic, onclick: () => ideaClick(ic, d) },
    h("span", { class: "idea-ic" }, icon(ic)), h("b", { text: t }), h("span", { text: d.trim() }))));
  /** Video needs the user's Google key, so that card opens the Video Studio (which explains it) with the idea filled in. */
  function ideaClick(ic, d) {
    if (ic !== "film") return fillComposer(d);
    openStudio("video");
    const t = $("#video-text");
    if (!t.value.trim()) { t.value = d.replace(/^Make a 4-second video:s*/, ""); t.dispatchEvent(new Event("input", { bubbles: true })); }
  }
  /** The user's own saved prompts, as quick buttons under the cards on the start screen. */
  function paintMineIdeas() {
    const box = $("#mine-ideas"), mine = (S.prompts || []).slice(0, 6);
    box.hidden = !mine.length;
    box.replaceChildren(...(mine.length ? [h("div", { class: "mine-h", text: "Your prompts" }),
      ...mine.map((p) => h("button", { type: "button", class: "btn small", title: p.text.slice(0, 300), onclick: () => usePrompt(p) }, icon("book"), h("span", { text: p.title })))] : []));
  }

  // ---------- sessions ----------
  const pageTitle = () => `${S.session.title ? `${S.session.title} – ` : ""}AI Brain`;
  function paintTitle() {
    $("#session-title").textContent = S.session.title || "New session";
    if (!document.hidden || !/^[✓⚠]/.test(document.title)) document.title = pageTitle();
  }
  function noteTitle(text) {
    if (S.session.title) return;
    S.session.title = String(text).replace(/\s+/g, " ").trim().slice(0, 70) || "Untitled session";
    paintTitle();
  }
  async function renameSession(id, current) {
    const title = await askInput("Name this session", current || "", { max: 70 });
    if (!title) return;
    await tryApi("/api/session/rename", { id, title });
  }
  $("#session-title").addEventListener("click", () => renameSession(S.session.id, S.session.title));
  async function newSession() {
    if (await tryApi("/api/session/new")) { $("#dlg-sessions").close(); taskEl.focus(); }
  }
  async function switchSession(id) {
    if (id === S.session.id) { $("#dlg-sessions").close(); return; }
    if (await tryApi("/api/session/switch", { id })) $("#dlg-sessions").close();
  }
  function exportSession(id) {
    const a = h("a", { href: `/api/session/export?id=${encodeURIComponent(id)}`, download: "" });
    document.body.append(a);
    a.click();
    a.remove();
  }
  async function loadSessions() {
    const q = $("#sess-q").value.trim();
    let list;
    try { list = await api(`/api/sessions${q ? `?q=${encodeURIComponent(q)}` : ""}`); } catch { return; }
    if (!q) S.sessions = list;
    if (!$("#dlg-sessions").open) return;
    const box = $("#sess-list");
    if (!list.length) { box.replaceChildren(h("div", { class: "empty-note", text: q ? "No session matches that search." : "No saved sessions yet. Your conversations are kept here automatically." })); return; }
    box.replaceChildren(...list.map((s) => {
      const row = h("div", { class: `sess${s.active ? " active" : ""}`, tabindex: "0", role: "button", title: s.title },
        h("div", { class: "sess-title" }, s.pinned ? icon("star") : null, h("span", { text: s.title })),
        h("div", { class: "sess-meta", text: `${s.tasks} ${s.tasks === 1 ? "task" : "tasks"} · ${ago(s.updatedAt)}${s.active ? " · open now" : ""}` }));
      const stopClick = (fn) => (e) => { e.stopPropagation(); fn(); };
      row.append(h("div", { class: "sess-btns" },
        h("button", { class: `icon-btn${s.pinned ? " pinned" : ""}`, type: "button", title: s.pinned ? "Unpin" : "Pin to the top", "aria-label": s.pinned ? "Unpin" : "Pin", onclick: stopClick(() => tryApi("/api/session/pin", { id: s.id, pinned: !s.pinned })) }, icon("star")),
        h("button", { class: "icon-btn", type: "button", title: "Rename", "aria-label": "Rename", onclick: stopClick(() => renameSession(s.id, s.title)) }, icon("pen")),
        h("button", { class: "icon-btn", type: "button", title: "Save as a text file", "aria-label": "Export", onclick: stopClick(() => exportSession(s.id)) }, icon("download")),
        h("button", { class: "icon-btn danger", type: "button", title: "Delete", "aria-label": "Delete", onclick: stopClick(async () => {
          if (await confirmBox("Delete this session?", `“${s.title}” will be removed for good. Pictures stay in your Gallery.`, { yes: "Delete", danger: true })) await tryApi("/api/session/delete", { id: s.id });
        }) }, icon("trash"))));
      row.addEventListener("click", () => switchSession(s.id));
      row.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target === row) switchSession(s.id); });
      return row;
    }));
  }
  let sessTimer = null;
  const loadSessionsSoon = (ms = 200) => { clearTimeout(sessTimer); sessTimer = setTimeout(loadSessions, ms); };
  $("#sess-q").addEventListener("input", () => loadSessionsSoon(180));
  function openSessions() { openDlg("#dlg-sessions"); $("#sess-q").value = ""; loadSessions(); $("#sess-q").focus(); }
  $("#btn-sessions").addEventListener("click", openSessions);
  $("#btn-new").addEventListener("click", newSession);
  $("#sess-new").addEventListener("click", newSession);

  // ---------- gallery and picture viewer ----------
  const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  let galKind = "all";
  function paintMedia() {
    const all = S.media.map(mediaItem);
    $("#recent-strip").replaceChildren(...all.slice(0, 8).map((_, i) => thumb(all, i)));
    $("#gal-count").textContent = all.length;
    if (!$("#dlg-gallery").open) return;
    const isVid = all.map((it) => VIDEO_RE.test(it.name));
    // The choice only appears once there is at least one video and one picture.
    const mixed = isVid.includes(true) && isVid.includes(false);
    if (!mixed) galKind = "all";
    $("#gal-kind").hidden = !mixed;
    $$("#gal-kind button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.kind === galKind)));
    const idx = all.map((_, i) => i).filter((i) => galKind === "all" || isVid[i] === (galKind === "video"));
    const list = idx.map((i) => all[i]);
    const grid = $("#gal-grid");
    if (!list.length) grid.replaceChildren(h("div", { class: "empty-note", text: "No pictures yet. Ask the brain for a picture, or open the Image Studio." }));
    else grid.replaceChildren(...list.map((it, j) => thumb(list, j, `${ago(S.media[idx[j]].mtime)} · ${fmtSize(S.media[idx[j]].size)}`)));
  }
  $("#gal-kind").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-kind]");
    if (!b) return;
    galKind = b.dataset.kind;
    paintMedia();
  });
  async function loadMedia() {
    try { S.media = await api("/api/media"); } catch { return; }
    paintMedia();
  }
  function openGallery() { openDlg("#dlg-gallery"); paintMedia(); loadMedia(); }
  $("#btn-gallery").addEventListener("click", openGallery);
  $("#btn-gallery2").addEventListener("click", openGallery);

  const LB = { list: [], i: 0 };
  function paintLight() {
    const it = LB.list[LB.i];
    if (!it) { $("#dlg-light").close(); return; }
    if (!it.path) it.path = S.media.find((m) => m.url === it.url)?.path || null;
    $("#light-fig").replaceChildren(VIDEO_RE.test(it.name) ? h("video", { src: it.url, controls: true, autoplay: true }) : h("img", { src: it.url, alt: it.name }));
    $("#light-name").textContent = `${it.name}${LB.list.length > 1 ? `  (${LB.i + 1} of ${LB.list.length})` : ""}`;
    $("#light-prev").style.visibility = $("#light-next").style.visibility = LB.list.length > 1 ? "" : "hidden";
    $("#light-attach").hidden = !it.path;
    $("#light-path").hidden = !it.path;
    $("#light-copy").hidden = VIDEO_RE.test(it.name);
    $("#light-animate").hidden = !/^\/(media|uploads)\/[^/]+\.(png|jpe?g|webp)$/i.test(it.url.split("?")[0]);
    $("#light-folder").hidden = $("#light-delete").hidden = !it.isMedia;
    const dl = $("#light-download");
    dl.href = it.isMedia ? `${it.url}?download=1` : it.url;
    dl.setAttribute("download", it.name);
  }
  function openLight(list, i) {
    LB.list = list.slice();
    LB.i = Math.max(0, i);
    paintLight();
    openDlg("#dlg-light");
  }
  const lightStep = (d) => { if (LB.list.length > 1) { LB.i = (LB.i + d + LB.list.length) % LB.list.length; paintLight(); } };
  $("#light-prev").addEventListener("click", () => lightStep(-1));
  $("#light-next").addEventListener("click", () => lightStep(1));
  $("#light-fig").addEventListener("click", (e) => { if (e.target.id === "light-fig") $("#dlg-light").close(); });
  $("#dlg-light").addEventListener("close", () => $("#light-fig").replaceChildren());
  $("#light-attach").addEventListener("click", () => attachExisting(LB.list[LB.i]));
  $("#light-animate").addEventListener("click", () => {
    const it = LB.list[LB.i];
    $("#dlg-light").close();
    if ($("#dlg-gallery").open) $("#dlg-gallery").close();
    openStudio("video", { url: it.url.split("?")[0], name: it.name });
  });
  $("#light-path").addEventListener("click", () => copyText(LB.list[LB.i].path, "Path copied."));
  $("#light-folder").addEventListener("click", () => tryApi("/api/open", { target: "media", name: LB.list[LB.i].name }));
  $("#light-copy").addEventListener("click", async () => {
    try {
      const img = $("#light-fig img");
      const cv = h("canvas");
      cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      cv.getContext("2d").drawImage(img, 0, 0);
      const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Picture copied.", "ok", 1800);
    } catch { toast("Could not copy the picture. Use Download instead.", "err"); }
  });
  $("#light-delete").addEventListener("click", async () => {
    const it = LB.list[LB.i];
    if (!await confirmBox("Delete this picture?", `${it.name} will be removed from your computer for good.`, { yes: "Delete", danger: true })) return;
    if (!await tryApi("/api/media/delete", { name: it.name })) return;
    for (const pic of $$(".thumb img, .thumb video")) if (pic.getAttribute("src") === it.url) pic.closest(".thumb").remove();
    LB.list.splice(LB.i, 1);
    LB.i = Math.min(LB.i, LB.list.length - 1);
    paintLight();
    toast("Picture deleted.", "ok", 1800);
  });

  // ---------- image studio ----------
  const STYLES = [
    ["No style", ""], ["Photo", "photorealistic photograph, natural light, sharp detail"], ["Anime", "anime illustration, clean line art, vivid colours"],
    ["Dark fantasy", "dark fantasy painting, dramatic lighting, rich detail"], ["Oil painting", "classical oil painting, visible brush strokes"],
    ["Watercolour", "soft watercolour painting on paper"], ["3D render", "polished 3D render, soft studio lighting"],
    ["Pixel art", "retro pixel art, limited colour palette"], ["Logo", "minimal flat vector logo, centred, plain background"], ["Neon", "neon cyberpunk glow on a dark background"],
  ];
  const SHAPES = [["Any", ""], ["Square", "square (1:1)"], ["Wide", "wide landscape (16:9)"], ["Tall", "tall portrait (9:16)"]];
  const studio = { style: "", shape: "", waiting: false };
  // Video lives in the same window: a second mode with its own fields.
  const VSHAPES = [["Wide (16:9)", "16:9"], ["Tall (9:16)", "9:16"]];
  const VQUALITY = [["720p", "720p"], ["1080p", "1080p"]];
  const video = { mode: "picture", info: null, aspect: "16:9", seconds: 8, quality: "720p", waiting: false, id: null, from: null, t0: 0, timer: null };
  const isVeo = (id) => /(^|\/)veo/i.test(String(id || ""));
  function segButtons(box, list, key, obj = studio, after) {
    box.replaceChildren(...list.map(([label, value]) => h("button", {
      type: "button", "aria-pressed": String(obj[key] === value), text: label,
      onclick: () => { obj[key] = value; segButtons(box, list, key, obj, after); after?.(key); },
    })));
  }
  function studioPaint() {
    const go = $("#studio-go"), vid = video.mode === "video";
    const waiting = vid ? video.waiting : studio.waiting;
    go.replaceChildren(icon(waiting ? "stop" : vid ? "play" : "spark"), h("span", { text: waiting ? "Stop" : vid ? "Create video" : "Create" }));
    go.className = `btn ${waiting ? "danger" : "primary"}`;
    go.disabled = vid && !waiting && !!video.info && !video.info.connected;
  }
  function studioStatus(text, cls = "", busy = false, sel = "#studio-status") {
    const el = $(sel);
    el.hidden = !text;
    el.className = cls;
    el.replaceChildren(...(busy ? [typing()] : []), h("span", { class: "st-text", text: text || "" }));
  }
  const videoStatus = (text, cls, busy) => studioStatus(text, cls, busy, "#video-status");
  const videoModelName = (id) => (video.info?.models || []).find((m) => m.id === id)?.label.replace(/ \(.*/, "") || String(id || "").replace(/^models\//, "");
  async function loadVideoInfo() {
    try { video.info = await api("/api/video"); } catch { return; }
    paintVideo();
  }
  // Paints everything about video: the studio's video side and the Settings section.
  function paintVideo() {
    const info = video.info, s = S.settings || {}, model = s.videoModel || "", veo = isVeo(model), vid = video.mode === "video";
    $("#studio-pic").hidden = vid;
    $("#studio-vid").hidden = !vid;
    $("#t-studio").textContent = vid ? "Video Studio" : "Image Studio";
    for (const b of $$("#studio-mode button")) b.setAttribute("aria-pressed", String(b.dataset.mode === video.mode));
    $("#video-nokey").hidden = !info || info.connected;
    const lens = veo ? [4, 6, 8] : [5, 10];
    if (!veo) video.quality = "720p";
    if (!lens.includes(video.seconds)) video.seconds = lens[lens.length - 1];
    if (video.quality === "1080p") video.seconds = 8;
    const changed = (key) => {
      if (key === "seconds" && video.seconds !== 8) video.quality = "720p";
      paintVideo();
    };
    segButtons($("#video-shapes"), VSHAPES, "aspect", video);
    segButtons($("#video-lengths"), lens.map((n) => [`${n} seconds`, n]), "seconds", video, changed);
    segButtons($("#video-quality"), VQUALITY, "quality", video, changed);
    $("#video-quality-box").hidden = !veo;
    $("#video-from").hidden = !video.from;
    if (video.from) {
      $("#video-from img").src = video.from.url;
      $("#video-from-note").textContent = veo ? "The video starts from this picture" : "Starting from a picture needs a Veo model (Settings, under Video)";
    }
    $("#row-video-improve").hidden = !!video.from;
    const today = info?.usage?.today ?? 0, limit = s.videoDailyLimit ?? 10;
    $("#studio-note").textContent = !vid ? "Pictures are made by Gemini and saved to your Gallery."
      : `Made by Google ${videoModelName(model)} with your own key. Each video costs money. Today: ${today}${limit ? ` of ${limit}` : ""}.`;
    studioPaint();
    // Settings
    $("#set-video-state").textContent = !info ? "Checking…" : !info.connected ? "Not connected"
      : info.from === "saved" ? `Connected (key ends in ${info.ends})` : "Connected (the key comes from this computer's settings)";
    $("#set-video-state").classList.toggle("good", !!info?.connected);
    $("#set-video-remove").hidden = !(info?.connected && info.from === "saved");
    const sel = $("#set-video-model");
    const list = (info?.models || []).slice();
    if (model && !list.some((m) => m.id === model)) list.push({ id: model, label: model });
    sel.replaceChildren(...list.map((m) => h("option", { value: m.id, text: m.label })));
    sel.value = model;
    if (document.activeElement !== $("#set-video-limit")) $("#set-video-limit").value = limit;
    $("#set-video-today").textContent = `Protects you from a surprise bill. 0 = no limit. Made today: ${today}`;
  }
  function videoTick() {
    const secs = Math.max(0, Math.round((Date.now() - video.t0) / 1000));
    const el = $("#video-status .st-text");
    if (el) el.textContent = `Google is making your video… ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}  (usually one to three minutes; you can close this window and keep working)`;
    $("#sb-video").textContent = `Making a video… ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  }
  $("#sb-video").addEventListener("click", () => openStudio("video"));
  function videoWaiting(on) {
    video.waiting = on;
    $("#sb-video").hidden = !on;
    clearInterval(video.timer);
    video.timer = null;
    if (on) {
      if (!video.t0) video.t0 = Date.now();
      videoStatus("Google is making your video…", "", true);
      videoTick();
      video.timer = setInterval(videoTick, 1000);
    } else { video.id = null; video.t0 = 0; }
    studioPaint();
  }
  function videoDone(ev) {
    videoWaiting(false);
    loadVideoInfo();
    if (ev.stopped) { videoStatus("Stopped."); return; }
    if (ev.isError) { videoStatus(ev.text || "Google could not make the video.", "err"); return; }
    const url = (ev.images || []).find((u) => VIDEO_RE.test(u.split("?")[0]));
    if (!url) { videoStatus("Google answered, but no video came back. Try a simpler description.", "err"); return; }
    videoStatus("Done. The video is saved in your Gallery.");
    const it = mediaItem(url);
    $("#video-result").replaceChildren(
      h("video", { src: url, controls: true, loop: true, playsinline: true }),
      h("div", { class: "row-btns" },
        h("a", { class: "btn small", href: `${url}?download=1`, download: it.name }, icon("download"), h("span", { text: "Download" })),
        h("button", { type: "button", class: "btn small", onclick: () => tryApi("/api/open", { target: "media", name: it.name }) }, icon("folder"), h("span", { text: "Show in folder" }))));
    if (!$("#dlg-studio").open) toast("Your video is ready. It is in the Gallery.", "ok", 7000);
  }
  async function videoGo() {
    if (video.waiting) { await tryApi("/api/ask/stop", { to: "video" }); return; }
    const desc = $("#video-text").value.trim();
    if (!desc) { toast("Describe the video first."); $("#video-text").focus(); return; }
    if ($("#video-improve").checked && !video.from) {
      const ok = await sendTask(`Make a video for me. First turn my description into a strong, detailed video prompt (subject, action, camera movement, style, lighting, sounds), then create exactly one video with generate_video (aspect ${video.aspect}, ${video.seconds} seconds) and show me the result.\n\nMy description: ${desc}`);
      if (ok) { $("#dlg-studio").close(); toast("The brain is working on your video. It takes a few minutes.", "ok", 6000); }
      return;
    }
    const r = await tryApi("/api/video", { text: desc, aspect: video.aspect, seconds: video.seconds, resolution: video.quality, image: video.from?.url });
    if (!r) { loadVideoInfo(); return; }
    video.id = r.id;
    video.t0 = Date.now();
    $("#video-result").replaceChildren();
    videoWaiting(true);
  }
  function setStudioMode(mode) {
    video.mode = mode === "video" ? "video" : "picture";
    paintVideo();
    if (video.mode === "video") loadVideoInfo();
    $(video.mode === "video" ? "#video-text" : "#studio-text").focus();
  }
  for (const b of $$("#studio-mode button")) b.addEventListener("click", () => setStudioMode(b.dataset.mode));
  $("#video-flow").addEventListener("click", () => { $("#dlg-studio").close(); window.Station.openFlow(); });
  $("#video-setup").addEventListener("click", () => { openSettings(); $("#sec-video").scrollIntoView({ block: "start" }); $("#set-video-key").focus(); });
  $("#video-from-clear").addEventListener("click", () => { video.from = null; paintVideo(); });
  function studioDone(ev) {
    S.studioId = null;
    studio.waiting = false;
    studioPaint();
    if (ev.stopped) { studioStatus("Stopped."); return; }
    if (ev.isError) { studioStatus(ev.text || "Gemini could not make the picture.", "err"); return; }
    const pics = imgs(ev.images);
    if (!pics) { studioStatus("Gemini answered, but no picture came back. Try a simpler description.", "err"); return; }
    studioStatus("Done. The picture is saved in your Gallery.");
    $("#studio-result").replaceChildren(pics);
  }
  function openStudio(mode, from) {
    openDlg("#dlg-studio");
    segButtons($("#studio-styles"), STYLES, "style");
    segButtons($("#studio-shapes"), SHAPES, "shape");
    if (from) video.from = from;
    setStudioMode(typeof mode === "string" ? mode : video.mode);
  }
  $("#studio-go").addEventListener("click", async () => {
    if (video.mode === "video") { await videoGo(); return; }
    if (studio.waiting) { await tryApi("/api/ask/stop", { to: "gemini" }); return; }
    const desc = $("#studio-text").value.trim();
    if (!desc) { toast("Describe the picture first."); $("#studio-text").focus(); return; }
    const extra = `${studio.style ? `\nStyle: ${studio.style}.` : ""}${studio.shape ? `\nShape: ${studio.shape}.` : ""}`;
    if ($("#studio-improve").checked) {
      const ok = await sendTask(`Make a picture for me. First turn my description into a strong, detailed image prompt, then create it with generate_image and show me the result.\n\nMy description: ${desc}${extra}`);
      if (ok) { $("#dlg-studio").close(); toast("The brain is working on your picture.", "ok"); }
      return;
    }
    const r = await tryApi("/api/image", { text: `${desc}${extra}` });
    if (!r) return;
    S.studioId = r.id;
    studio.waiting = true;
    $("#studio-result").replaceChildren();
    studioStatus("Gemini is drawing your picture. This can take a minute…", "", true);
    studioPaint();
  });
  $("#btn-studio").addEventListener("click", () => openStudio());

  // ---------- prompt library ----------
  const BUILTIN = [
    ["Explain it simply", "Explain {{topic}} in simple words, with one everyday example. Then give me three questions to check that I understood."],
    ["Compare two options", "Compare {{option A}} and {{option B}}. Make a table of the main differences, ask Gemini for its opinion too, then tell me which one you would pick and why."],
    ["Fix my writing", "Fix the spelling and grammar of this text and make it clearer, but keep my voice. Show the improved text first, then list what you changed.\n\n{{text}}"],
    ["Write an email", "Write a short, polite email to {{who}} about {{what}}. Give me a friendly version and a formal version."],
    ["Plan my week", "Help me plan my week. My main goals are: {{goals}}. Make a simple day-by-day plan with realistic time blocks."],
    ["Brainstorm ideas", "Give me 10 ideas for {{what}}. Ask Gemini for 5 more, remove the duplicates, and rank the best five with one line each."],
    ["Summarise this", "Summarise this in five bullet points, then one sentence with the most important takeaway:\n\n{{text}}"],
    ["Make a picture", "Create a picture of {{subject}}. Write a detailed image prompt first, then generate it."],
    ["Translate", "Translate this into {{language}}. Keep the tone natural, and note anything that does not translate directly.\n\n{{text}}"],
    ["Check my idea", "Here is my idea: {{idea}}\n\nBe honest: list the three biggest risks, the three best things about it, and what you would do first. Get a second opinion from Gemini."],
  ].map(([title, text]) => ({ title, text }));
  let editingPrompt = null;
  async function fillVars(text) {
    const names = [...new Set([...text.matchAll(/\{\{\s*([^{}]{1,40}?)\s*\}\}/g)].map((m) => m[1]))];
    let out = text;
    for (const name of names) {
      const val = await askInput(`Fill in: ${name}`, "", { max: 2000, placeholder: name });
      if (val == null) return null;
      out = out.replace(new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}\\}`, "g"), () => val || name);
    }
    return out;
  }
  async function usePrompt(p) {
    const text = await fillVars(p.text);
    if (text != null) fillComposer(text);
  }
  async function savePrompts(list) {
    const saved = await tryApi("/api/prompts", { prompts: list });
    if (saved) { S.prompts = saved; paintPrompts(); paintMineIdeas(); }
    return saved;
  }
  function promptItem(p, mine) {
    const list = [act("up", "Use", () => usePrompt(p), "Put this prompt in the task box")];
    if (mine) {
      list.push(act("pen", "Edit", () => {
        editingPrompt = p.id;
        $("#prompt-title").value = p.title; $("#prompt-text").value = p.text;
        $("#prompt-save").textContent = "Save changes"; $("#prompt-cancel").hidden = false;
        $("#prompt-title").focus();
      }));
      list.push(act("trash", "Delete", async () => {
        if (await confirmBox("Delete this prompt?", p.title, { yes: "Delete", danger: true })) savePrompts(S.prompts.filter((x) => x.id !== p.id));
      }));
    } else {
      list.push(act("plus", "Copy to mine", async () => { if (await savePrompts([...S.prompts, { title: p.title, text: p.text }])) toast("Added to your prompts.", "ok", 1800); }));
    }
    return h("div", { class: "p-item" }, h("b", { text: p.title }), h("p", { text: p.text, dir: "auto" }), actions("", list));
  }
  function paintPrompts() {
    $("#prompts-mine").replaceChildren(...(S.prompts.length ? S.prompts.map((p) => promptItem(p, true)) : [h("div", { class: "empty-note", text: "Prompts you save appear here. Write {{something}} in a prompt and the app asks you to fill it in each time." })]));
    $("#prompts-built").replaceChildren(...BUILTIN.map((p) => promptItem(p, false)));
  }
  function resetPromptForm() {
    editingPrompt = null;
    $("#prompt-form").reset();
    $("#prompt-save").textContent = "Save prompt";
    $("#prompt-cancel").hidden = true;
  }
  $("#prompt-cancel").addEventListener("click", resetPromptForm);
  $("#prompt-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = $("#prompt-title").value.trim(), text = $("#prompt-text").value.trim();
    if (!title || !text) { toast("Give the prompt a name and some text."); return; }
    const list = editingPrompt ? S.prompts.map((p) => (p.id === editingPrompt ? { ...p, title, text } : p)) : [...S.prompts, { title, text }];
    if (await savePrompts(list)) { resetPromptForm(); toast("Prompt saved.", "ok", 1800); }
  });
  async function loadPrompts() {
    try { S.prompts = await api("/api/prompts"); } catch { return; }
    paintMineIdeas();
    paintPrompts();
  }
  function openPrompts() { openDlg("#dlg-prompts"); paintPrompts(); }
  $("#btn-prompts").addEventListener("click", openPrompts);
  $("#btn-prompts2").addEventListener("click", openPrompts);

  // ---------- saved answers ----------
  function paintSaved() {
    $("#saved-count").textContent = S.saved.length;
    if (!$("#dlg-saved").open) return;
    const box = $("#saved-list");
    if (!S.saved.length) { box.replaceChildren(h("div", { class: "empty-note", text: "Nothing saved yet. Press “Save” under any answer to keep it here." })); return; }
    box.replaceChildren(...S.saved.map((it) => h("div", { class: "saved-item" },
      h("div", { class: "who" }, h("b", { text: NAME[it.who] || "Claude" }), h("span", { text: `${new Date(it.t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}${it.session ? ` · ${short(it.session, 50)}` : ""}` })),
      mdBox(it.text), imgs(it.images),
      actions("", [
        act("copy", "Copy", () => copyText(it.text)),
        act("up", "Use in a task", () => fillComposer(it.text, true)),
        act("trash", "Delete", async () => { if (await confirmBox("Remove this saved answer?", short(it.text, 120), { yes: "Remove", danger: true })) tryApi("/api/saved/delete", { id: it.id }); }),
      ]))));
  }
  async function loadSaved() {
    try { S.saved = await api("/api/saved"); } catch { return; }
    paintSaved();
  }
  function openSaved() { openDlg("#dlg-saved"); paintSaved(); }
  $("#btn-saved").addEventListener("click", openSaved);

  // ---------- focus mode, theme, quit ----------
  function setZen(on) {
    document.body.classList.toggle("zen", on);
    $("#btn-zen").classList.toggle("on", on);
    store.set("zen", on);
  }
  $("#btn-zen").addEventListener("click", () => setZen(!document.body.classList.contains("zen")));
  const THEMES = ["dark", "neon", "goth", "berserk"];
  const THEME_NAMES = { dark: "Dark", neon: "Neon", goth: "Goth", berserk: "Berserk" };
  const switchTheme = () => saveSetting({ theme: THEMES[(THEMES.indexOf(S.settings?.theme) + 1) % THEMES.length] });
  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-help").addEventListener("click", () => openDlg("#dlg-help"));
  async function quit() {
    const busy = S.busy || S.queue.length;
    if (!await confirmBox("Quit AI Brain?", busy ? "The brain is still working. Quitting stops the task." : "The app will stop running in the background. Open it again from the desktop shortcut.", { yes: "Quit", danger: !!busy })) return;
    S.closing = true;
    try { es?.close(); } catch { /* already closed */ }
    try { await api("/api/shutdown", {}); } catch { /* it may close before answering */ }
    for (const d of [...dlgStack]) d.close();
    $("#offline").hidden = true;
    $("#closed").hidden = false;
    fxKick();
    setTimeout(() => { try { window.close(); } catch { /* the browser decides */ } }, 600);
  }
  $("#btn-quit").addEventListener("click", quit);

  // ---------- command search ----------
  const COMMANDS = [
    ["plus", "New session", "Alt+N", newSession],
    ["menu", "Open sessions", "Alt+S", openSessions],
    ["spark", "Image Studio", "Alt+I", () => openStudio("picture")],
    ["play", "Video Studio (Google Veo)", "Alt+V", () => openStudio("video")],
    ["ext", "Google Flow (Google's video maker)", "", () => window.Station.openFlow()],
    ["ext", "Google Flow: open only to sign in (if Google blocks the sign-in)", "", () => window.Station.openFlow(false, true)],
    ["grid", "Gallery", "Alt+G", openGallery],
    ["book", "Prompt library", "Alt+P", openPrompts],
    ["bookmark", "Saved answers", "Alt+B", openSaved],
    ["eye", "Focus mode on / off", "Alt+Z", () => setZen(!document.body.classList.contains("zen"))],
    ["star", "Switch theme", "Alt+T", switchTheme],
    ...THEMES.map((t) => ["palette", `Theme: ${THEME_NAMES[t]}`, "", () => saveSetting({ theme: t })]),
    ["layout", "Layout: Focus (conversation only)", "Alt+1", () => window.Station?.preset("focus")],
    ["layout", "Layout: Station", "Alt+2", () => window.Station?.preset("station")],
    ["layout", "Layout: Everything", "Alt+3", () => window.Station?.preset("all")],
    ["layout", "Layout: Social (Discord and music)", "Alt+4", () => window.Station?.preset("social")],
    ["layout", "Layout: Mine (your saved layout)", "Alt+5", () => window.Station?.preset("mine")],
    ["layout", "Save this layout as Mine", "", () => window.Station?.saveMine()],
    ["gauge", "Show usage (Claude, Gemini and ChatGPT)", "Alt+U", () => window.Station?.show("usage")],
    ["activity", "Show activity", "Alt+L", () => window.Station?.show("activity")],
    ["music", "Music: play or pause", "Alt+M", () => window.Station?.music("toggle")],
    ["next", "Music: next song", "", () => window.Station?.music("next")],
    ["prev", "Music: previous song", "", () => window.Station?.music("prev")],
    ["ext", "Open Spotify", "", () => tryApi("/api/open-app", { app: "spotify" })],
    ["chat", "Show Discord", "Alt+D", () => window.Station?.show("discord")],
    ["window", "Show your programs (Apps)", "Alt+A", () => window.Station?.show("apps")],
    ["window", "Put the program in the middle back", "", () => window.Station?.appBack()],
    ["full", "Full screen on / off", "F11", () => window.Station?.fullscreen()],
    ["spark", "Work mode: Auto", "", () => window.Station?.mode("auto")],
    ["spark", "Work mode: Solo (Claude alone)", "", () => window.Station?.mode("solo")],
    ["spark", "Work mode: Team (Claude and Gemini)", "", () => window.Station?.mode("team")],
    ["spark", "Work mode: Debate", "", () => window.Station?.mode("debate")],
    ["spark", "Work mode: Extreme (most careful)", "", () => window.Station?.mode("extreme")],
    ["gear", "Settings", "Ctrl+,", openSettings],
    ["stop", "Stop the brain", "Ctrl+.", () => tryApi("/api/stop")],
    ["download", "Save this session as a text file", "", () => exportSession(S.session.id)],
    ["pen", "Rename this session", "", () => renameSession(S.session.id, S.session.title)],
    ["clip", "Attach files", "", () => $("#file-input").click()],
    ["folder", "Open the pictures folder", "", () => tryApi("/api/open", { target: "media" })],
    ["trash", "Clear the activity list", "", () => logEl.replaceChildren()],
    ["help", "Help and shortcuts", "F1", () => openDlg("#dlg-help")],
    ["spark", "What's new in version 3", "", () => openDlg("#dlg-new")],
    ["power", "Quit AI Brain", "", quit],
  ].map(([ic, label, hint, run]) => ({ ic, label, hint, run }));
  const pal = { items: [], sel: 0 };
  function paintPalette() {
    const q = $("#pal-q").value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const all = [
      ...COMMANDS,
      ...S.sessions.filter((s) => !s.active).map((s) => ({ ic: "menu", label: `Session: ${s.title}`, hint: ago(s.updatedAt), run: () => switchSession(s.id) })),
      ...[...S.prompts, ...BUILTIN].map((p) => ({ ic: "book", label: `Prompt: ${p.title}`, hint: "", run: () => usePrompt(p) })),
    ];
    pal.items = all.filter((it) => q.every((w) => it.label.toLowerCase().includes(w))).slice(0, 40);
    pal.sel = Math.min(pal.sel, Math.max(0, pal.items.length - 1));
    const box = $("#pal-list");
    if (!pal.items.length) { box.replaceChildren(h("div", { class: "empty-note", text: "Nothing matches." })); return; }
    box.replaceChildren(...pal.items.map((it, i) => {
      const row = h("div", { class: `pal-item${i === pal.sel ? " sel" : ""}`, role: "option", "aria-selected": String(i === pal.sel) }, icon(it.ic), h("span", { text: it.label }), it.hint ? h("small", { text: it.hint }) : null);
      row.addEventListener("click", () => runPalette(i));
      row.addEventListener("mousemove", () => { if (pal.sel !== i) { pal.sel = i; for (const [j, r] of [...box.children].entries()) r.classList.toggle("sel", j === i); } });
      return row;
    }));
    box.children[pal.sel]?.scrollIntoView({ block: "nearest" });
  }
  function runPalette(i) {
    const it = pal.items[i];
    if (!it) return;
    $("#dlg-palette").close();
    it.run();
  }
  function openPalette() {
    if ($("#dlg-palette").open) { $("#dlg-palette").close(); return; }
    openDlg("#dlg-palette");
    $("#pal-q").value = "";
    pal.sel = 0;
    paintPalette();
    $("#pal-q").focus();
    loadSessions().then(() => { if ($("#dlg-palette").open) paintPalette(); });
  }
  $("#pal-q").addEventListener("input", () => { pal.sel = 0; paintPalette(); });
  $("#pal-q").addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); pal.sel = Math.min(pal.sel + 1, pal.items.length - 1); paintPalette(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); pal.sel = Math.max(pal.sel - 1, 0); paintPalette(); }
    else if (e.key === "Enter") { e.preventDefault(); runPalette(pal.sel); }
  });
  $("#btn-palette").addEventListener("click", openPalette);

  // ---------- keyboard ----------
  const ALT_KEYS = { KeyN: newSession, KeyS: openSessions, KeyI: () => openStudio("picture"), KeyV: () => openStudio("video"), KeyG: openGallery, KeyP: openPrompts, KeyB: openSaved, KeyZ: () => setZen(!document.body.classList.contains("zen")), KeyT: switchTheme,
    Digit1: () => window.Station?.preset("focus"), Digit2: () => window.Station?.preset("station"), Digit3: () => window.Station?.preset("all"),
    Digit4: () => window.Station?.preset("social"), Digit5: () => window.Station?.preset("mine"),
    KeyM: () => window.Station?.music("toggle"), KeyU: () => window.Station?.show("usage"), KeyD: () => window.Station?.show("discord"), KeyA: () => window.Station?.show("apps"), KeyL: () => window.Station?.show("activity") };
  document.addEventListener("keydown", (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (S.closing) return;
    if (ctrl && !e.altKey && e.code === "KeyK") { e.preventDefault(); openPalette(); return; }
    if (dlgStack.length) {
      if (dlgStack[dlgStack.length - 1].id === "dlg-light") {
        if (e.key === "ArrowLeft") lightStep(-1);
        else if (e.key === "ArrowRight") lightStep(1);
      }
      return;
    }
    if (ctrl && e.code === "Period") { e.preventDefault(); if (S.busy) tryApi("/api/stop"); return; }
    if (ctrl && e.code === "Comma") { e.preventDefault(); openSettings(); return; }
    if (e.altKey && !ctrl && ALT_KEYS[e.code]) { e.preventDefault(); ALT_KEYS[e.code](); return; }
    if (e.key === "F1") { e.preventDefault(); openDlg("#dlg-help"); return; }
    if (e.key === "F11") { e.preventDefault(); window.Station?.fullscreen(); return; }
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (e.key === "/" && !inField && !ctrl && !e.altKey) { e.preventDefault(); taskEl.focus(); return; }
    if (e.key === "Escape") {
      const max = $(".panel.max");
      if (max) toggleMax(max, false);
      else if (document.body.classList.contains("zen")) setZen(false);
    }
  });

  // ---------- events from the server ----------
  function resetView() {
    dropLive();
    pending.clear();
    for (const m of $$(".msg", thread)) m.remove();
    emptyEl.hidden = false;
    jumpBtn.hidden = true;
    for (const who of HELPERS) $(`#${who}-log`).replaceChildren();
    logEl.replaceChildren();
    S.stats = { tasks: 0, calls: 0, images: new Set(), secs: [] };
    S.lastTask = null;
    S.taskImages = [];
    S.taskStart = 0;
  }
  function onTask(ev) {
    S.stats.tasks++;
    S.lastTask = ev;
    S.taskStart = ev.t || Date.now();
    S.taskImages = [];
    noteTitle(ev.text);
    addToThread(msgTask(ev), true);
    logLine(`You: ${short(ev.text, 90)}`, "", ev.t);
    if (!S.replaying) paintStats();
  }
  function onFinal(ev) {
    const failed = ev.isError || ev.stopped;
    if (ev.seconds != null && !failed) S.stats.secs.push(ev.seconds);
    const images = failed ? [] : [...new Set([...(ev.images || []), ...S.taskImages])];
    for (const u of images) S.stats.images.add(u);
    const el = msgFinal(ev, S.lastTask, images);
    if (S.replaying) addToThread(el);
    else {
      const stick = atBottom(thread);
      dropLive();
      addToThread(el, stick);
    }
    S.taskImages = [];
    logLine(ev.stopped ? "Task stopped" : ev.isError ? "The task ended with a problem" : `${NAME[ev.brain] || "Claude"} finished${ev.seconds != null ? ` in ${dur(ev.seconds)}` : ""}`, ev.stopped ? "warn" : ev.isError ? "error" : "good", ev.t);
    if (!S.replaying) { paintStats(); announce(ev); }
  }
  function handle(ev) {
    switch (ev.type) {
      case "hello":
        S.replaying = true;
        resetView();
        S.session = { id: ev.session?.id || "", title: ev.session?.title || "" };
        paintTitle();
        break;
      case "ready":
        S.replaying = false;
        S.queue = ev.queue || [];
        S.direct = { chatgpt: !!ev.direct?.chatgpt, gemini: !!ev.direct?.gemini, video: !!ev.direct?.video };
        // A video that was started before this window (re)opened keeps its Stop button.
        if (S.direct.video !== video.waiting) { videoWaiting(S.direct.video); if (!S.direct.video) videoStatus(""); }
        S.phase = ev.phase || "idle";
        setBusy(!!ev.busy);
        if (ev.busy) { liveText = ev.live || ""; paintLive(); }
        if (ev.usage) paintUsage(ev.usage);
        if (S.studioId && !S.direct.gemini) { S.studioId = null; studio.waiting = false; studioStatus(""); }
        approve.list = [];
        for (const a of ev.approvals || []) approve.list.push(a);
        paintApproval();
        paintQueue(); paintDirect(); paintStats(); refreshCalling();
        requestAnimationFrame(() => {
          scrollDown();
          for (const who of HELPERS) { const l = $(`#${who}-log`); l.scrollTop = l.scrollHeight; }
          logEl.scrollTop = logEl.scrollHeight;
        });
        break;
      case "task": onTask(ev); break;
      case "claude_say": addToThread(msgNote(ev)); break;
      case "call": onCall(ev); break;
      case "reply": onReply(ev); break;
      case "reply_cancel": onReplyCancel(ev); break;
      case "final": onFinal(ev); break;
      case "log": logLine(ev.text, ev.level === "error" ? "error" : ev.level === "warn" ? "warn" : /^Claude online/.test(ev.text) ? "claude" : /^ChatGPT online/.test(ev.text) ? "chatgpt" : "", ev.t); break;
      case "stream": setLive(ev.text); break;
      case "phase": S.phase = ev.phase; paintStage(); break;
      case "busy": setBusy(ev.value); break;
      case "approval": approvalAdd(ev); break;
      case "approval_done": approvalGone(ev.id); break;
      case "queue": S.queue = ev.items || []; paintQueue(); break;
      case "direct":
        S.direct[ev.who] = !!ev.value; paintDirect(); paintStage();
        if (ev.who === "video" && !ev.value && video.waiting) { videoWaiting(false); videoStatus(""); loadVideoInfo(); }
        break;
      case "video_state": loadVideoInfo(); refreshStatus(true); break;
      case "helper_state":
        if (S.status?.[ev.who] && !S.status[ev.who].off) {
          S.status[ev.who].ok = !!ev.ok;
          if (ev.who === "gemini") S.status.gemini.detail = ev.ok ? "Ready (Antigravity)" : "Last request failed";
          paintStatus();
        }
        break;
      case "usage": paintUsage(ev); break;
      case "media": loadMedia(); break;
      case "flow-open": if (window.Station?.hasShell?.()) window.Station.openFlow(true); break;
      case "app-control": window.Station?.control?.(ev); break;
      case "inspect": paintInspect(ev); break;
      case "sessions": loadSessionsSoon(); break;
      case "settings": applySettings(ev.settings); break;
      case "title": S.session.title = ev.title || ""; paintTitle(); break;
      case "prompts": loadPrompts(); break;
      case "saved": loadSaved(); break;
      default: break;
    }
  }

  let es = null, offlineTimer = null;
  function connect() {
    es = new EventSource("/events");
    es.onopen = () => { clearTimeout(offlineTimer); offlineTimer = null; $("#offline").hidden = true; };
    es.onmessage = (m) => {
      let ev;
      try { ev = JSON.parse(m.data); } catch { return; }
      try { handle(ev); } catch (err) { console.error("event failed", ev?.type, err); }
      try { window.Station?.event?.(ev); } catch (err) { console.error("station event failed", ev?.type, err); }
    };
    es.onerror = () => {
      if (S.closing || offlineTimer) return;
      offlineTimer = setTimeout(() => { offlineTimer = null; if (!S.closing && es.readyState !== 1) $("#offline").hidden = false; }, 1500);
    };
  }

  // ---------- what's new ----------
  $("#help-new").addEventListener("click", () => { $("#dlg-help").close(); openDlg("#dlg-new"); });
  $$("#dlg-new [data-new]").forEach((b) => b.addEventListener("click", () => {
    $("#dlg-new").close();
    if (b.dataset.new === "settings") openSettings();
    else if (b.dataset.new === "video") openStudio("video");
    else if (b.dataset.new === "usage") window.Station.show("usage");
    else if (b.dataset.new === "goth" || b.dataset.new === "berserk") saveSetting({ theme: b.dataset.new });
    else if (b.dataset.new === "flow-setting") { openSettings(); setTimeout(() => $("#sec-video")?.scrollIntoView({ block: "start" }), 150); }
    else window.Station.openFlow();
  }));

  // ---------- start ----------
  // Themes that were removed open as Berserk (the server moves the saved choice over in the same way).
  const cachedTheme = ({ clover: "berserk", demon: "berserk", wind: "berserk" })[store.get("theme", null)] || store.get("theme", null);
  if (THEMES.includes(cachedTheme)) root.dataset.theme = cachedTheme;
  if (store.get("zen", false)) setZen(true);
  // The workstation script (station.js) builds the docks, usage, music and Discord panels with these.
  window.Brain = {
    S, $, $$, h, icon, svgUse, api, tryApi, toast, store, openDlg, confirmBox, copyText, atBottom, short, clock, dur, mmss,
    saveSetting, openSettings, openStudio, THEMES, THEME_NAMES, openGallery, openPrompts, openSaved, openSessions, newSession, toggleMax, setZen,
  };
  taskEl.value = store.get("draft", "") || "";
  grow(taskEl);
  fxColors();
  fxSize();
  paintStats();
  (async () => {
    try { applySettings(await api("/api/settings")); } catch { /* the event stream will bring them */ }
    connect();
    refreshStatus();
    loadMedia();
    loadPrompts();
    loadSaved();
    loadSessions();
    taskEl.focus();
    // Only once the new version is really running (not this page on a server that was not restarted yet).
    if (newsDue && parseFloat((await api("/api/ping").catch(() => null))?.version) >= NEWS) {
      setTimeout(() => { if (!document.querySelector("dialog[open]")) { openDlg("#dlg-new"); store.set("news", NEWS); } }, 700);
    }
  })();
})();
