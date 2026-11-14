// AI Brain dashboard. Everything shown here comes from real events streamed by app-server.mjs.
const $ = (s) => document.querySelector(s);
const NAMES = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", you: "You" };
const feeds = { center: $("#task-feed"), chatgpt: $("#chatgpt-feed"), gemini: $("#gemini-feed") };
const pending = new Map(); // call id -> { el, to }
let busy = false;
let attachments = []; // { path, url, name }

// ---------- helpers ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clock = (t) => new Date(t || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const trunc = (s, n = 160) => (s.length > n ? s.slice(0, n) + "…" : s);

function md(text) {
  // small, safe markdown: code blocks, inline code, bold, italics, headings, lists, links
  const blocks = String(text ?? "").replace(/!\[[^\]]*\]\([^)]*\)/g, "").split(/```/);
  return blocks.map((b, i) => {
    if (i % 2) return `<pre><code>${esc(b.replace(/^[\w-]*\n/, ""))}</code></pre>`;
    let h = esc(b)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<i>$2</i>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    const out = [];
    let list = null;
    for (const line of h.split("\n")) {
      const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
      if (li) { if (!list) { list = []; } list.push(`<li>${li[1]}</li>`); continue; }
      if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; }
      const hd = line.match(/^#{1,4}\s+(.*)/);
      if (hd) out.push(`<h4>${hd[1]}</h4>`);
      else if (line.trim()) out.push(`<p>${line}</p>`);
    }
    if (list) out.push(`<ul>${list.join("")}</ul>`);
    return out.join("");
  }).join("");
}

function mediaEl(url) {
  const isVid = /\.(mp4|webm|mov)$/i.test(decodeURIComponent(url));
  const el = document.createElement(isVid ? "video" : "img");
  el.src = url; el.loading = "lazy"; if (isVid) el.muted = true;
  el.onclick = () => openLightbox(url);
  return el;
}

function scrollDown(el) { el.scrollTop = el.scrollHeight; }

function addMsg(feed, { who, cls = "", head, text, images = [], t }) {
  if (feed === feeds.center) feed.querySelector("#task-empty")?.remove();
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.innerHTML = `<div class="head"><b>${esc(head || NAMES[who] || who)}</b><span>${clock(t)}</span></div><div class="body">${md(text)}</div>`;
  if (images.length) {
    const pics = document.createElement("div");
    pics.className = "pics";
    images.forEach((u) => pics.appendChild(mediaEl(u)));
    div.appendChild(pics);
  }
  feed.appendChild(div);
  if (String(text).length > 900) {
    div.classList.add("collapsed");
    const b = document.createElement("button");
    b.className = "more"; b.textContent = "Show more";
    b.onclick = () => { const c = div.classList.toggle("collapsed"); b.textContent = c ? "Show more" : "Show less"; };
    div.appendChild(b);
  }
  scrollDown(feed);
  return div;
}

function addPending(feed, id, to, label, t) {
  const p = document.createElement("div");
  p.className = "pending";
  p.innerHTML = `<span class="spin"></span><span>${esc(label)}</span><span class="secs"></span>`;
  feed.appendChild(p);
  scrollDown(feed);
  pending.set(id, { el: p, to, t: t || Date.now() });
  refreshActivity();
}
setInterval(() => {
  for (const { el, t } of pending.values()) el.querySelector(".secs").textContent = `${Math.round((Date.now() - t) / 1000)}s`;
}, 1000);

function clearPending(id) {
  const p = pending.get(id);
  if (p) { p.el.remove(); pending.delete(id); }
  refreshActivity();
}

function log(level, html, t) {
  const box = $("#claude-log");
  const e = document.createElement("div");
  e.className = `e ${level}`;
  e.innerHTML = `<time>${clock(t)}</time>${html}`;
  box.appendChild(e);
  while (box.children.length > 400) box.firstChild.remove();
  scrollDown(box);
}

// ---------- activity: panel glow + wires ----------
function refreshActivity() {
  const active = { chatgpt: false, gemini: false };
  for (const p of pending.values()) active[p.to] = true;
  for (const who of ["chatgpt", "gemini"]) {
    $(`#panel-${who}`).classList.toggle("working", active[who]);
    const st = $(`#state-${who}`);
    st.textContent = active[who] ? "Working…" : "Idle";
    st.classList.toggle("on", active[who]);
  }
  $("#panel-claude").classList.toggle("working", busy);
  $("#state-claude").textContent = busy ? (active.chatgpt || active.gemini ? "Delegating…" : "Thinking…") : "Idle";
  $("#state-claude").classList.toggle("on", busy);
  $("#panel-center").classList.toggle("working", busy);
  $("#state-task").textContent = busy ? "Running" : "Ready";
  $("#state-task").classList.toggle("on", busy);
  drawWires(active);
}

function drawWires(active = {}) {
  const svg = $("#wires");
  if (getComputedStyle(svg).display === "none") return;
  const r = (id) => $(id).getBoundingClientRect();
  const cl = r("#panel-claude"), ce = r("#panel-center"), gp = r("#panel-chatgpt"), ge = r("#panel-gemini");
  const css = getComputedStyle(document.documentElement);
  const col = (v) => css.getPropertyValue(v).trim();
  const curve = (x1, y1, x2, y2) => { const mx = (x1 + x2) / 2; return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`; };
  const wires = [
    { d: curve(cl.right, cl.top + cl.height * 0.35, ce.left, ce.top + ce.height * 0.35), c: col("--claude"), on: busy },
    { d: curve(ce.right, ce.top + ce.height * 0.3, gp.left, gp.top + gp.height * 0.5), c: col("--chatgpt"), on: active.chatgpt },
    { d: curve(ce.right, ce.top + ce.height * 0.7, ge.left, ge.top + ge.height * 0.5), c: col("--gemini"), on: active.gemini },
  ];
  svg.innerHTML = `<defs><filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>` +
    wires.map((w) => `<path d="${w.d}" stroke="${w.c}" filter="url(#glow)" class="${w.on ? "active" : ""}"/><path d="${w.d}" stroke="${w.c}" class="flow ${w.on ? "active" : ""}"/>`).join("") +
    wires.map((w) => { const m = w.d.match(/M([\d.]+),([\d.]+).* ([\d.]+),([\d.]+)$/); return m ? `<circle cx="${m[1]}" cy="${m[2]}" r="4" fill="${w.c}" filter="url(#glow)"/><circle cx="${m[3]}" cy="${m[4]}" r="4" fill="${w.c}" filter="url(#glow)"/>` : ""; }).join("");
}
window.addEventListener("resize", () => refreshActivity());

// ---------- events ----------
function resetUI() {
  pending.clear();
  $("#claude-log").innerHTML = "";
  feeds.chatgpt.innerHTML = ""; feeds.gemini.innerHTML = "";
  feeds.center.innerHTML = "";
  feeds.center.appendChild(emptyTpl.cloneNode(true));
  bindIdeas();
}

function handle(ev) {
  switch (ev.type) {
    case "hello": resetUI(); setBusy(ev.busy); break;
    case "reset": resetUI(); loadMedia(); break;
    case "busy": setBusy(ev.value); break;
    case "task": {
      addMsg(feeds.center, { who: "you", cls: "you", text: ev.text, images: (ev.files || []).map((f) => f.url).filter(Boolean), t: ev.t });
      addPending(feeds.center, "brain", "claude", "Claude is working on it…", ev.t);
      log("info", `New task: ${esc(trunc(ev.text, 120))}`, ev.t);
      break;
    }
    case "log": log(ev.level || "info", esc(ev.text), ev.t); break;
    case "claude_say": log("think", `<span class="who">Claude:</span> ${esc(trunc(ev.text, 600))}`, ev.t); break;
    case "call": {
      const from = ev.from === "you" ? "You" : "Claude";
      addMsg(feeds[ev.to], { who: ev.from, cls: ev.from === "you" ? "you" : "from-claude", head: `${from} → ${NAMES[ev.to]}`, text: ev.prompt, t: ev.t });
      addPending(feeds[ev.to], ev.id, ev.to, `${NAMES[ev.to]} is replying…`, ev.t);
      if (ev.from === "claude") log(`to-${ev.to}`, `<span class="who">→ ${NAMES[ev.to]}:</span> ${esc(trunc(ev.prompt))}`, ev.t);
      break;
    }
    case "reply": {
      const p = pending.get(ev.id);
      const secs = p ? Math.round((ev.t - p.t) / 1000) : null;
      clearPending(ev.id);
      addMsg(feeds[ev.to], { who: ev.to, cls: `reply-${ev.to}${ev.isError ? " err" : ""}`, head: ev.isError ? `${NAMES[ev.to]} - error` : NAMES[ev.to], text: ev.text, images: ev.images || [], t: ev.t });
      log(ev.isError ? "error" : `to-${ev.to}`, `<span class="who">← ${NAMES[ev.to]}</span> ${ev.isError ? "failed" : "replied"}${secs != null ? ` (${secs}s)` : ""}${ev.images?.length ? ` · ${ev.images.length} image(s)` : ""}`, ev.t);
      if (ev.images?.length) loadMedia();
      break;
    }
    case "reply_cancel": clearPending(ev.id); break;
    case "final": {
      clearPending("brain");
      addMsg(feeds.center, { who: "claude", cls: `final${ev.isError ? " err" : ""}`, head: `Claude${ev.seconds ? ` · ${ev.seconds}s` : ""}`, text: ev.text, images: ev.images || [], t: ev.t });
      log(ev.isError ? "error" : "done", ev.isError ? "Task ended with an error." : `Task complete${ev.seconds ? ` in ${ev.seconds}s` : ""}.`, ev.t);
      break;
    }
    case "usage": {
      if (typeof ev.five_hour === "number") {
        const pct = Math.round(ev.five_hour * 100);
        $("#usage-bar").style.width = `${pct}%`;
        $("#usage-text").textContent = `${pct}%`;
      }
      break;
    }
    case "helper_state": setChip(ev.who, ev.ok, ev.ok ? "Working" : "Last request failed"); break;
    case "media": loadMedia(); break;
  }
}

function setBusy(v) {
  busy = !!v;
  $("#btn-send").disabled = busy;
  $("#btn-stop").hidden = !busy;
  $("#composer-hint").textContent = busy ? "The brain is working - watch the panels." : "";
  if (!busy) clearPending("brain");
  refreshActivity();
}

function connect() {
  if (location.search.includes("preview")) { // one-shot load (used for screenshots)
    fetch("/api/history").then((r) => r.json()).then((evs) => { evs.forEach(handle); $("#conn-dot").className = "dot on"; $("#conn-text").textContent = "Connected"; });
    return;
  }
  const es = new EventSource("/events");
  es.onopen = () => { $("#conn-dot").className = "dot on"; $("#conn-text").textContent = "Connected"; };
  es.onerror = () => { $("#conn-dot").className = "dot off"; $("#conn-text").textContent = "Disconnected - retrying…"; };
  es.onmessage = (m) => { try { handle(JSON.parse(m.data)); } catch (e) { console.error(e); } };
}

// ---------- status chips ----------
function setChip(who, ok, detail) {
  const c = $(`#chip-${who}`);
  c.classList.toggle("ok", ok); c.classList.toggle("bad", !ok);
  c.querySelector("i").textContent = ok ? "●" : "○";
  c.title = detail || "";
  if (who === "chatgpt") $("#signin-chatgpt").hidden = ok;
}
async function loadStatus(force) {
  try {
    const s = await (await fetch(`/api/status${force ? "?force" : ""}`)).json();
    for (const who of ["claude", "chatgpt", "gemini"]) setChip(who, s[who].ok, s[who].detail);
  } catch {}
}

// ---------- media gallery ----------
async function loadMedia() {
  try {
    const items = await (await fetch("/api/media")).json();
    const strip = $("#media-strip");
    strip.innerHTML = "";
    if (!items.length) strip.innerHTML = '<div class="none">Images Gemini creates will appear here.</div>';
    items.slice(0, 60).forEach((it) => { const el = mediaEl(it.url); el.title = it.path; strip.appendChild(el); });
    $("#media-count").textContent = items.length ? `${items.length} file${items.length > 1 ? "s" : ""} · workspace\\media` : "";
  } catch {}
}

function openLightbox(url) {
  const lb = $("#lightbox"), img = lb.querySelector("img"), vid = lb.querySelector("video");
  const isVid = /\.(mp4|webm|mov)$/i.test(decodeURIComponent(url));
  img.hidden = isVid; vid.hidden = !isVid;
  if (isVid) vid.src = url; else img.src = url;
  lb.querySelector("p").textContent = decodeURIComponent(url.split("/").pop());
  lb.hidden = false;
}
$("#lightbox").onclick = (e) => { if (e.target.tagName !== "P") { $("#lightbox").hidden = true; $("#lightbox video").pause(); } };

// ---------- actions ----------
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), 4500);
}
async function post(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

async function sendTask() {
  const input = $("#task-input");
  const text = input.value.trim();
  if (!text || busy) return;
  try {
    await post("/api/task", { text, files: attachments.map((a) => a.path) });
    input.value = ""; attachments = []; renderAttachments();
  } catch (e) { toast(e.message); }
}
$("#btn-send").onclick = sendTask;
$("#task-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTask(); } });
$("#btn-stop").onclick = () => post("/api/stop").catch((e) => toast(e.message));
$("#btn-reset").onclick = async () => {
  if (!confirm("Start a new session? Claude, ChatGPT and Gemini will all forget this conversation (transcripts stay saved).")) return;
  post("/api/reset").catch((e) => toast(e.message));
};
$("#btn-quit").onclick = async () => {
  if (!confirm("Shut down AI Brain? (Open it again from the desktop shortcut.)")) return;
  await post("/api/shutdown").catch(() => {});
  window.close();
  document.body.innerHTML = '<p style="margin:auto;font-family:Orbitron">AI Brain is shut down. You can close this window.</p>';
};
$("#btn-login-chatgpt").onclick = async () => {
  await post("/api/login/chatgpt").catch((e) => toast(e.message));
  toast("A sign-in window opened. Finish signing in with your ChatGPT account in the browser.");
  let n = 0;
  const iv = setInterval(async () => { await loadStatus(true); if (++n > 40 || !$("#signin-chatgpt").hidden) clearInterval(iv); }, 6000);
};

document.querySelectorAll("form.mini").forEach((f) => {
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const inp = f.querySelector("input");
    const text = inp.value.trim();
    if (!text) return;
    try { await post("/api/ask", { to: f.dataset.to, text }); inp.value = ""; }
    catch (err) { toast(err.message); }
  });
});

// attachments
async function upload(files) {
  for (const file of files) {
    try {
      const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Upload failed");
      attachments.push({ ...j, name: file.name });
    } catch (e) { toast(`${file.name}: ${e.message}`); }
  }
  renderAttachments();
}
function renderAttachments() {
  const box = $("#attachments");
  box.innerHTML = "";
  attachments.forEach((a, i) => {
    const d = document.createElement("span");
    d.className = "att";
    d.innerHTML = `${a.url ? `<img src="${a.url}" alt="">` : "📄"}<span>${esc(trunc(a.name, 28))}</span><button title="Remove">✕</button>`;
    d.querySelector("button").onclick = () => { attachments.splice(i, 1); renderAttachments(); };
    box.appendChild(d);
  });
}
$("#file-input").onchange = (e) => { upload([...e.target.files]); e.target.value = ""; };
const composer = $("#composer");
["dragenter", "dragover"].forEach((t) => composer.addEventListener(t, (e) => { e.preventDefault(); composer.classList.add("drag"); }));
["dragleave", "drop"].forEach((t) => composer.addEventListener(t, (e) => { e.preventDefault(); composer.classList.remove("drag"); }));
composer.addEventListener("drop", (e) => upload([...e.dataTransfer.files]));
$("#task-input").addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); upload(files); }
});

// idea buttons
const emptyTpl = $("#task-empty").cloneNode(true);
function bindIdeas() {
  document.querySelectorAll(".ideas button").forEach((b) => (b.onclick = () => { $("#task-input").value = b.textContent; $("#task-input").focus(); }));
}

// ---------- start ----------
bindIdeas();
connect();
loadStatus();
loadMedia();
setInterval(loadStatus, 60_000);
requestAnimationFrame(() => refreshActivity());
