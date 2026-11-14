// AI Brain inspector - the popup: pair with AI Brain, share or stop sharing this tab.
"use strict";
const $ = (s) => document.querySelector(s);
const ask = (m) => chrome.runtime.sendMessage(m);
let tabId = 0;

async function paint() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id || 0;
  const s = await ask({ what: "state", tabId });
  const st = s.status?.state;
  $("#dot").className = `dot${st === "connected" ? " on" : st === "wrong-code" ? " bad" : ""}`;
  $("#dot").title = st || "";
  $("#state").textContent = st === "unpaired" ? "Not paired with AI Brain yet."
    : st === "connected" ? (s.status.why || "Connected to AI Brain.")
    : st === "wrong-code" ? "The pairing code is wrong or was replaced. Paste the code from AI Brain again."
    : st === "offline" ? "AI Brain is not running. Open it, then try again."
    : "Connecting to AI Brain…";
  $("#state").classList.toggle("warn", st === "wrong-code" || (st === "connected" && !!s.status.why));
  $("#pair").hidden = !(st === "unpaired" || st === "wrong-code");
  $("#unpair").hidden = !s.paired;
  const web = /^https?:|^file:/.test(s.tab?.url || "");
  $("#here").hidden = !s.paired || st === "wrong-code";
  $("#here-text").textContent = !web ? "This page cannot be shared (browser pages and the extension store are off limits)." : s.sharedHere ? "This tab is shared with AI Brain." : `Share "${s.tab?.title || s.tab?.url}" with AI Brain?`;
  $("#share").hidden = s.sharedHere;
  $("#share").disabled = !web;
  $("#unshare").hidden = !s.sharedHere;
  $("#list").hidden = !s.tabs?.length;
  $("#tabs").replaceChildren(...(s.tabs || []).map((t) => { const li = document.createElement("li"); li.textContent = t.title || t.url; li.title = t.url; return li; }));
}

$("#pair-btn").addEventListener("click", async () => {
  $("#pair-btn").disabled = true;
  await ask({ what: "pair", code: $("#code").value });
  $("#pair-btn").disabled = false;
  paint();
});
$("#code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#pair-btn").click(); });
$("#share").addEventListener("click", async () => {
  $("#share").disabled = true;
  const r = await ask({ what: "share", tabId });
  if (!r?.ok) { $("#here-text").textContent = `Could not share: ${r?.why || "unknown"}`; $("#share").disabled = false; return; }
  paint();
});
$("#unshare").addEventListener("click", async () => { await ask({ what: "unshare", tabId }); paint(); });
$("#unpair").addEventListener("click", async (e) => { e.preventDefault(); await ask({ what: "unpair" }); paint(); });
paint();
