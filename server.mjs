#!/usr/bin/env node
// MCP server: gives Claude tools to talk to ChatGPT (Codex CLI) and Gemini
// (Antigravity CLI) using subscription logins - no API keys. stdout is reserved
// for the MCP protocol - never console.log here.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http from "node:http";
import { askChatGPT, askGemini, generateImage, generateVideo, googleKeyState, resetConversations, LOGS } from "./lib.mjs";
import { flowLook, flowClick, flowType, flowWait, flowSaveVideos, flowMakeVideo } from "./flow.mjs";

// The AI Brain app sets AI_BRAIN_CHATGPT=0 while ChatGPT is switched off in its settings.
const CHATGPT = process.env.AI_BRAIN_CHATGPT !== "0";

const server = new McpServer({ name: "ai-brain", version: "3.1.0" });

const text = (t) => ({ content: [{ type: "text", text: t }] });
const fail = (e) => ({ content: [{ type: "text", text: String(e?.message || e) }], isError: true });

if (CHATGPT) server.registerTool(
  "ask_chatgpt",
  {
    title: "Ask ChatGPT",
    description:
      "Send a message to ChatGPT (the user's ChatGPT login via the Codex CLI) and get its reply. " +
      "Continues the same conversation unless new_conversation is true. Runs read-only.",
    inputSchema: {
      prompt: z.string().describe("The message to send"),
      new_conversation: z.boolean().optional().describe("Start a fresh conversation"),
      image_paths: z.array(z.string()).optional().describe("Absolute paths of images to attach"),
      model: z.string().optional().describe("Optional model override"),
    },
  },
  async ({ prompt, new_conversation, image_paths, model }) => {
    try {
      return text((await askChatGPT(prompt, { newConversation: new_conversation, imagePaths: image_paths ?? [], model })).text);
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "ask_gemini",
  {
    title: "Ask Gemini",
    description:
      "Send a message to Gemini (the user's Google login via the Antigravity CLI) and get its reply. " +
      "Gemini can also GENERATE IMAGES: ask it to; generated files are saved and their paths are listed at the end of the reply. " +
      "Continues the same conversation unless new_conversation is true. Runs read-only.",
    inputSchema: {
      prompt: z.string().describe("The message to send"),
      new_conversation: z.boolean().optional().describe("Start a fresh conversation"),
      model: z.string().optional().describe("Optional model override"),
    },
  },
  async ({ prompt, new_conversation, model }) => {
    try {
      return text((await askGemini(prompt, { newConversation: new_conversation, model })).text);
    } catch (e) { return fail(e); }
  }
);

server.registerTool(
  "generate_image",
  {
    title: "Generate image (Gemini)",
    description:
      "Have Gemini generate an image from a detailed description. Returns the saved file path(s). " +
      "Write a rich prompt: subject, style, lighting, composition, aspect ratio.",
    inputSchema: {
      description: z.string().describe("Detailed description of the image"),
    },
  },
  async ({ description }) => {
    try {
      return text((await generateImage(description)).text);
    } catch (e) { return fail(e); }
  }
);

// Video is only offered once the user added a Google API key in the app's settings.
if (googleKeyState().connected) server.registerTool(
  "generate_video",
  {
    title: "Generate video (Google Veo)",
    description:
      "Make ONE short video clip (about 8 seconds, with sound) from a detailed description, using Google's video model. " +
      "It costs the user money per video and takes a few minutes: call it only when the user asked for a video, once per video they asked for. " +
      "Returns the saved file path. Write a rich prompt: subject, action, camera movement, style, lighting, sounds.",
    inputSchema: {
      description: z.string().describe("Detailed description of the video"),
      aspect: z.enum(["16:9", "9:16"]).optional().describe("16:9 = wide (default), 9:16 = tall"),
      seconds: z.number().int().min(4).max(10).optional().describe("Length in seconds (default: the longest the model allows)"),
    },
  },
  async ({ description, aspect, seconds }) => {
    try {
      return text((await generateVideo(description, { aspect, seconds })).text);
    } catch (e) { return fail(e); }
  }
);

// Google Flow (Veo 3.1 through the user's Google plan, no API key): the brain uses the Flow window
// that AI Brain opened. Switched off with "Let the brain use Google Flow" in Settings.
if (process.env.AI_BRAIN_FLOW === "1") {
  const run = (fn) => async (a) => { try { return text(await fn(a)); } catch (e) { return fail(e); } };
  server.registerTool("flow_make_video", {
    title: "Make a video in Google Flow",
    description:
      "Make ONE video with Google Flow (Veo 3.1, using the user's Google plan credits, no API key): types the description into Flow's prompt box, " +
      "starts it, waits for the new video and saves it. Returns the saved file path. Takes a few minutes. Call it only when the user asked for a video, once per video. " +
      "If it reports a problem, use flow_look to see the page and the small flow_ tools to finish by hand. Write a rich prompt: subject, action, camera, style, lighting, sounds.",
    inputSchema: {
      description: z.string().describe("Detailed description of the video"),
      wait_seconds: z.number().int().min(30).max(900).optional().describe("How long to wait for the video (default 480)"),
    },
  }, run(({ description, wait_seconds }) => flowMakeVideo(description, wait_seconds)));
  server.registerTool("flow_look", {
    title: "Look at Google Flow",
    description: "Read the Google Flow page that is open in AI Brain: its text, and a numbered list of everything you can click or type in. Use before flow_click / flow_type.",
    inputSchema: {},
  }, run(() => flowLook()));
  server.registerTool("flow_click", {
    title: "Click in Google Flow",
    description: "Click a button, tab or link on the Google Flow page, by its number from flow_look or by its words. Only the Flow page is ever touched.",
    inputSchema: { target: z.string().describe("The number from flow_look, or the words on the button") },
  }, run(({ target }) => flowClick(target)));
  server.registerTool("flow_type", {
    title: "Type in Google Flow",
    description: "Type text into a text box on the Google Flow page (replacing what is in it). Without field, the biggest text box (the prompt box) is used.",
    inputSchema: {
      text: z.string().describe("What to type"),
      field: z.string().optional().describe("The number or words of the text box from flow_look"),
      press_enter: z.boolean().optional().describe("Press Enter afterwards"),
    },
  }, run(({ text: t, field, press_enter }) => flowType(t, field || "", !!press_enter)));
  server.registerTool("flow_wait", {
    title: "Wait for Google Flow",
    description: "Wait until a new video appears on the Flow page, or until some words appear (for example a finished message). Up to 900 seconds.",
    inputSchema: {
      seconds: z.number().int().min(2).max(900).describe("How long to wait at most"),
      words: z.string().optional().describe("Wait for these words instead of a new video"),
    },
  }, run(({ seconds, words }) => flowWait(seconds, words || "")));
  server.registerTool("flow_save_videos", {
    title: "Save videos from Google Flow",
    description: "Save the newest video(s) on the Flow page into the AI Brain gallery. Returns the saved file paths.",
    inputSchema: { count: z.number().int().min(1).max(8).optional().describe("How many of the newest videos (default 1)") },
  }, run(({ count }) => flowSaveVideos(count || 1)));
}

// The program in the middle of AI Brain (Blender, an editor, a browser...): the brain sees it and uses
// the real mouse and keyboard in it. Only while "Let the brain use the program in the middle" is on;
// each step goes to the AI Brain window with this task's key, and only the docked program is touched.
const APP_URL = process.env.AI_BRAIN_APP_URL;
const CONTROL_KEY = process.env.AI_BRAIN_CONTROL_KEY;
if (process.env.AI_BRAIN_APPS === "1" && APP_URL && CONTROL_KEY) {
  const step = (cmd, args = {}) => new Promise((resolve, reject) => {
    const u = new URL("/api/apps/control", APP_URL);
    const body = JSON.stringify({ cmd, args });
    const req = http.request(u, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Origin: u.origin, "X-Brain-Key": CONTROL_KEY },
    }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { s += d; });
      res.on("end", () => { try { resolve(JSON.parse(s)); } catch { reject(new Error(`AI Brain answered ${res.statusCode}.`)); } });
    });
    req.on("error", () => reject(new Error("AI Brain is not running, so no program can be used.")));
    req.end(body);
  });
  // The answer to every step: what was done, the picture, and the numbered list.
  const show = (r) => {
    if (!r?.ok) return { content: [{ type: "text", text: String(r?.why || "It did not work.") }], isError: true };
    const lines = [];
    if (r.did) lines.push(r.did);
    lines.push(`Program: ${r.name}${r.title && r.title !== r.name ? ` - window title "${r.title}"` : ""}. Picture: ${r.image.w} x ${r.image.h} pixels (x to the right, y down, from the top-left corner).`);
    if (r.front === false) lines.push("Note: the program could not be brought to the front, so something may cover it in the picture.");
    for (const p of r.popups || []) lines.push(`Also open: a window "${p.title}" at (${p.x}, ${p.y}), ${p.w} x ${p.h}.`);
    if (r.items?.length) {
      lines.push("", "Things on screen (click by number; x,y = top-left corner, then width x height):");
      for (const it of r.items) {
        const extra = it.password ? " [password box - never type into it]" : it.value !== undefined && it.value !== "" ? ` value="${it.value}"` : "";
        lines.push(`${it.n}. ${it.kind} "${it.name}"${extra}${it.disabled ? " (disabled)" : ""} at ${it.x},${it.y} ${it.w}x${it.h}`);
      }
      if (r.complete === false) lines.push("(The list may be incomplete: the program was slow to describe itself.)");
    } else {
      lines.push("", "This program lists nothing it can be clicked by (it draws everything itself, like Blender or a game). Use the picture: click by x and y, and use its keyboard shortcuts.");
    }
    return { content: [{ type: "text", text: lines.join("\n") }, { type: "image", data: r.image.data, mimeType: r.image.type || "image/png" }] };
  };
  const run = (cmd, pick) => async (a) => { try { return show(await step(cmd, pick ? pick(a) : a)); } catch (e) { return fail(e); } };
  const spot = {
    target: z.number().int().min(1).optional().describe("The number of the thing from the list (best when it is listed)"),
    x: z.number().optional().describe("Or: x in the picture, in pixels from the left"),
    y: z.number().optional().describe("Or: y in the picture, in pixels from the top"),
  };
  const wait = { wait_ms: z.number().int().min(150).max(5000).optional().describe("How long to let the program react before the new picture (default 500)") };

  server.registerTool("app_open", {
    title: "Open a program in AI Brain",
    description: "Open one of the programs the user added to AI Brain's Apps panel, in the middle of AI Brain, and look at it. If you do not know the names, call it with any name: the answer lists them.",
    inputSchema: { name: z.string().describe("The program's name as shown in the Apps panel") },
  }, run("open"));
  server.registerTool("app_look", {
    title: "Look at the program",
    description: "See the program in the middle of AI Brain: a picture of it and a numbered list of its buttons, menus, text boxes and other things. Use it first, and whenever you are not sure what is on screen.",
    inputSchema: {},
  }, run("look"));
  server.registerTool("app_click", {
    title: "Click in the program",
    description: "Click in the program, on a thing from the app_look list (target) or at x,y in the picture. Uses the real mouse. Returns a new picture.",
    inputSchema: {
      ...spot,
      button: z.enum(["left", "right", "middle", "none"]).optional().describe("Mouse button (default left; none = only move the mouse there, to hover)"),
      count: z.number().int().min(1).max(3).optional().describe("2 = double-click, 3 = triple-click (default 1)"),
      ...wait,
    },
  }, run("click"));
  server.registerTool("app_type", {
    title: "Type in the program",
    description: "Type text into the program where its keyboard focus is (click the text box first). \\n becomes Enter. Uses the real keyboard. Never type passwords. Returns a new picture.",
    inputSchema: { text: z.string().min(1).max(20000).describe("The text to type"), ...wait },
  }, run("type"));
  server.registerTool("app_key", {
    title: "Press keys in the program",
    description: "Press a key or shortcut in the program, like enter, esc, tab, ctrl+s, ctrl+shift+z, alt+f, f5, delete, up, or a single character. Keys that would leave the program (Windows key, Alt+Tab) are never pressed. Returns a new picture.",
    inputSchema: {
      keys: z.string().min(1).max(60).describe("The key or shortcut, with + between keys"),
      times: z.number().int().min(1).max(50).optional().describe("How many times to press it (default 1)"),
      ...wait,
    },
  }, run("key"));
  server.registerTool("app_scroll", {
    title: "Scroll in the program",
    description: "Turn the mouse wheel over a spot in the program (a list, a page, a 3D view to zoom). Returns a new picture.",
    inputSchema: {
      ...spot,
      amount: z.number().int().min(-50).max(50).describe("Wheel steps: positive = up (or zoom in), negative = down"),
      horizontal: z.boolean().optional().describe("Scroll sideways instead (positive = right)"),
      ...wait,
    },
  }, run("scroll"));
  server.registerTool("app_drag", {
    title: "Drag in the program",
    description: "Press the mouse at one spot, move it to another and let go (move a slider, a window part, an object, draw a line, select an area). Returns a new picture.",
    inputSchema: {
      from_target: z.number().int().min(1).optional().describe("Start: number from the list"),
      from_x: z.number().optional().describe("Or start x in the picture"),
      from_y: z.number().optional().describe("Or start y in the picture"),
      to_target: z.number().int().min(1).optional().describe("End: number from the list"),
      to_x: z.number().optional().describe("Or end x in the picture"),
      to_y: z.number().optional().describe("Or end y in the picture"),
      button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button to hold (default left; Blender rotates the view with middle)"),
      ...wait,
    },
  }, run("drag"));
}

// Web inspector: tabs the user shared with the AI Brain extension in their own browser (signed in as
// them). Like DevTools: page code, network, console, cookies, styles, JavaScript, screenshots. Only while
// "Let the brain inspect your shared tabs" is on; each step goes to AI Brain with this task's key.
if (process.env.AI_BRAIN_INSPECT === "1" && APP_URL && CONTROL_KEY) {
  const step = (cmd, args = {}) => new Promise((resolve, reject) => {
    const u = new URL("/api/inspect/request", APP_URL);
    const body = JSON.stringify({ cmd, args });
    const req = http.request(u, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Origin: u.origin, "X-Brain-Key": CONTROL_KEY },
    }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { s += d; });
      res.on("end", () => { try { resolve(JSON.parse(s)); } catch { reject(new Error(`AI Brain answered ${res.statusCode}.`)); } });
    });
    req.on("error", () => reject(new Error("AI Brain is not running, so no tab can be inspected.")));
    req.end(body);
  });
  const clip = (s, n) => { s = String(s ?? ""); return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters not shown; ask for a smaller part)` : s; };
  const tabLine = (t) => `tab ${t.id}: "${t.title}" ${t.url}`;
  const kb = (n) => (n == null || n < 0 ? "?" : n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
  // How each answer is shown to the brain.
  const SHOW = {
    tabs: (r) => r.tabs?.length ? `Shared tabs (newest first):\n${r.tabs.map(tabLine).join("\n")}` : "No tab is shared. Ask the user to open the page and click the AI Brain extension button on it.",
    html: (r) => `${tabLine(r.tab)}\n${r.selector ? `Part: ${r.selector}${r.count > 1 ? ` (first of ${r.count} matches)` : ""}` : "The whole page (live, as it is now)"}:\n\n${clip(r.html, r.max || 60000)}`,
    eval: (r) => `${tabLine(r.tab)}\n${r.error ? `ERROR: ${r.error}` : `Result (${r.type}):\n${clip(r.value, 40000)}`}`,
    network: (r) => {
      const rows = (r.requests || []).map((q) => `#${q.n} ${q.method} ${q.status ?? (q.failed ? "FAILED" : "...")} ${q.type || ""} ${q.url}  (${kb(q.size)}${q.ms != null ? `, ${q.ms} ms` : ""}${q.failed ? `, ${q.failed}` : ""})`);
      return `${tabLine(r.tab)}\nRequests since the tab was shared${r.filter ? ` matching "${r.filter}"` : ""}: ${r.total} in all, ${rows.length} shown (newest last). Use web_response with the # number for details.\n${rows.join("\n") || "(none yet - reload with web_go to watch the page load)"}`;
    },
    response: (r) => [tabLine(r.tab), `#${r.n} ${r.method} ${r.url}`, `Status: ${r.status ?? "?"} ${r.statusText || ""}`.trim(),
      `Request headers:\n${Object.entries(r.requestHeaders || {}).map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  (none)"}`,
      ...(r.postData ? [`Request body:\n${clip(r.postData, 20000)}`] : []),
      `Response headers:\n${Object.entries(r.responseHeaders || {}).map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  (none)"}`,
      r.body == null ? `Response body: ${r.bodyWhy || "not available"}` : `Response body${r.base64 ? " (binary, base64)" : ""}:\n${clip(r.body, 50000)}`].join("\n"),
    console: (r) => `${tabLine(r.tab)}\nConsole since the tab was shared: ${r.total} in all, ${(r.messages || []).length} shown (newest last).\n${(r.messages || []).map((m) => `[${m.level}] ${m.text}${m.where ? `  (${m.where})` : ""}`).join("\n") || "(empty)"}`,
    cookies: (r) => `${tabLine(r.tab)}\nCookies this page can use: ${(r.cookies || []).length}${r.values ? "" : " (values hidden; ask with include_values only if the user wants them)"}\n${(r.cookies || []).map((c) => `${c.name}${r.values ? `=${c.value}` : ""}  domain=${c.domain} path=${c.path}${c.httpOnly ? " HttpOnly" : ""}${c.secure ? " Secure" : ""}${c.sameSite ? ` SameSite=${c.sameSite}` : ""}${c.session ? " session" : ` expires=${new Date(c.expires * 1000).toISOString()}`}`).join("\n")}`,
    styles: (r) => `${tabLine(r.tab)}\n${r.selector}${r.count > 1 ? ` (first of ${r.count} matches)` : ""}: box ${r.box ? `${r.box.x},${r.box.y} ${r.box.w}x${r.box.h}` : "?"}\n${Object.entries(r.styles || {}).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`,
    screenshot: (r) => `${tabLine(r.tab)}\nScreenshot of the visible part (${r.w} x ${r.h}).`,
    go: (r) => `${tabLine(r.tab)}\n${r.did}${r.loaded ? " The page finished loading." : " It was still loading when this answer was sent."}`,
  };
  const run = (cmd) => async (a) => {
    try {
      const r = await step(cmd, a || {});
      if (!r?.ok) return { content: [{ type: "text", text: String(r?.why || "It did not work.") }], isError: true };
      const content = [{ type: "text", text: SHOW[cmd](r) }];
      if (r.image?.data) content.push({ type: "image", data: r.image.data, mimeType: r.image.type || "image/png" });
      return { content };
    } catch (e) { return fail(e); }
  };
  const tab = { tab: z.number().int().optional().describe("Which shared tab (number from web_tabs); default: the last one shared") };

  server.registerTool("web_tabs", { title: "Shared browser tabs", description: "List the tabs the user shared with the AI Brain extension in their browser. Use first.", inputSchema: {} }, run("tabs"));
  server.registerTool("web_html", {
    title: "Page code",
    description: "Read the live HTML of a shared tab (as it is now, after scripts ran), or one part of it by CSS selector.",
    inputSchema: { ...tab, selector: z.string().max(500).optional().describe("CSS selector of the part to read (default: the whole page)"), max: z.number().int().min(1000).max(200000).optional().describe("Most characters to return (default 60000)") },
  }, run("html"));
  server.registerTool("web_eval", {
    title: "Run JavaScript in the page",
    description: "Run a JavaScript expression in a shared tab and get the result (promises are awaited; objects come back as JSON). Read-only use unless the user asked for a change.",
    inputSchema: { ...tab, expression: z.string().min(1).max(20000).describe("The JavaScript expression, e.g. document.title or [...document.links].map(a => a.href)") },
  }, run("eval"));
  server.registerTool("web_network", {
    title: "Network requests",
    description: "List the network requests a shared tab made since it was shared: method, status, type, size, time. Reload with web_go first to see a whole page load.",
    inputSchema: { ...tab, filter: z.string().max(200).optional().describe("Only requests whose address contains this"), limit: z.number().int().min(1).max(300).optional().describe("Most rows (default 80, newest)") },
  }, run("network"));
  server.registerTool("web_response", {
    title: "One network request",
    description: "Show one request from web_network in full: request and response headers, request body and response body.",
    inputSchema: { ...tab, request: z.number().int().min(1).describe("The # number from web_network") },
  }, run("response"));
  server.registerTool("web_console", {
    title: "Console",
    description: "Show the console messages and JavaScript errors of a shared tab since it was shared.",
    inputSchema: { ...tab, level: z.enum(["all", "errors", "warnings"]).optional().describe("Default all"), limit: z.number().int().min(1).max(300).optional().describe("Most messages (default 100, newest)") },
  }, run("console"));
  server.registerTool("web_cookies", {
    title: "Cookies",
    description: "List the cookies of a shared tab's page (name, domain, flags, expiry). Values are hidden unless include_values is true - only when the user asked for them.",
    inputSchema: { ...tab, include_values: z.boolean().optional() },
  }, run("cookies"));
  server.registerTool("web_styles", {
    title: "Styles",
    description: "Computed CSS styles and the box (position and size) of an element in a shared tab.",
    inputSchema: { ...tab, selector: z.string().min(1).max(500).describe("CSS selector"), properties: z.array(z.string().max(60)).max(60).optional().describe("Only these properties (default: the common layout, color and font ones)") },
  }, run("styles"));
  server.registerTool("web_screenshot", { title: "Screenshot of the tab", description: "A picture of the visible part of a shared tab.", inputSchema: { ...tab } }, run("screenshot"));
  server.registerTool("web_go", {
    title: "Reload or open an address",
    description: "Reload a shared tab (to watch it load in web_network), or open another address in it. It stays shared.",
    inputSchema: { ...tab, url: z.string().max(2000).optional().describe("Address to open; without it the tab is reloaded"), bypass_cache: z.boolean().optional().describe("Reload without the cache") },
  }, run("go"));
}

if (CHATGPT) server.registerTool(
  "ask_both",
  {
    title: "Ask ChatGPT and Gemini",
    description: "Send the same message to ChatGPT and Gemini at the same time and return both replies.",
    inputSchema: {
      prompt: z.string().describe("The message to send to both"),
      new_conversation: z.boolean().optional().describe("Start fresh conversations"),
    },
  },
  async ({ prompt, new_conversation }) => {
    const opts = { newConversation: new_conversation };
    const [c, g] = await Promise.allSettled([askChatGPT(prompt, opts), askGemini(prompt, opts)]);
    const show = (r) => (r.status === "fulfilled" ? r.value.text : `ERROR: ${r.reason?.message || r.reason}`);
    return text(`=== ChatGPT ===\n${show(c)}\n\n=== Gemini ===\n${show(g)}`);
  }
);

server.registerTool(
  "reset_conversations",
  {
    title: "Reset conversations",
    description: `Forget the ongoing ChatGPT and Gemini conversations so the next message starts fresh. Transcripts stay in ${LOGS}.`,
    inputSchema: {},
  },
  async () => { resetConversations(); return text("Conversations reset."); }
);

// Permission check. Claude calls this (through --permission-prompt-tool) before it changes a file or
// runs a command. It asks the AI Brain window and waits for the user's click. Anything that goes
// wrong (app gone, no answer, bad reply) counts as "no".
const APPROVE_URL = process.env.AI_BRAIN_APPROVE_URL;
const APPROVE_KEY = process.env.AI_BRAIN_APPROVE_KEY;
if (APPROVE_URL && APPROVE_KEY) server.registerTool(
  "approve",
  {
    title: "Ask the user",
    description: "Used by the AI Brain app to ask the user before a change. Never call it yourself.",
    inputSchema: { tool_name: z.string(), input: z.any(), tool_use_id: z.string().optional() },
  },
  async (args) => {
    const no = (message) => text(JSON.stringify({ behavior: "deny", message }));
    if (/approve/i.test(args.tool_name)) return no("Not allowed.");
    try {
      const reply = await new Promise((resolve, reject) => {
        const u = new URL(APPROVE_URL);
        const body = JSON.stringify({ tool_name: args.tool_name, input: args.input ?? {}, tool_use_id: args.tool_use_id || "" });
        const req = http.request(u, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), Origin: u.origin, "X-Brain-Key": APPROVE_KEY },
        }, (res) => {
          let s = "";
          res.setEncoding("utf8");
          res.on("data", (d) => { s += d; });
          res.on("end", () => { try { resolve(res.statusCode === 200 ? JSON.parse(s) : { behavior: "deny", message: "The app refused the request." }); } catch (e) { reject(e); } });
        });
        req.on("error", reject);
        req.end(body);
      });
      if (reply?.behavior === "allow") return text(JSON.stringify({ behavior: "allow", updatedInput: args.input ?? {} }));
      return no(String(reply?.message || "The user did not allow this."));
    } catch {
      return no("AI Brain could not ask the user, so this was not allowed.");
    }
  }
);

await server.connect(new StdioServerTransport());
