#!/usr/bin/env node
// MCP server: gives the brain (Claude, or ChatGPT when the user picked it) tools to talk to the
// helper AIs - ChatGPT (Codex CLI), Gemini (Antigravity CLI), Claude (Claude Code) - using subscription
// logins, no API keys. stdout is reserved for the MCP protocol - never console.log here.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { askChatGPT, askGemini, askClaude, generateImage, generateVideo, googleKeyState, resetConversations, forbidden, LOGS, WORK, MEDIA_RE } from "./lib.mjs";
import { flowLook, flowClick, flowType, flowWait, flowSaveVideos, flowMakeVideo } from "./flow.mjs";

// Which AI is the brain (AI_BRAIN_BRAIN): "claude" (default) or "chatgpt". The brain is never its own helper.
const BRAIN = process.env.AI_BRAIN_BRAIN === "chatgpt" ? "chatgpt" : "claude";
// The AI Brain app sets AI_BRAIN_CHATGPT=0 while ChatGPT is switched off in its settings.
const CHATGPT = process.env.AI_BRAIN_CHATGPT !== "0" && BRAIN !== "chatgpt";
// The second helper next to Gemini (ask_both): ChatGPT, or Claude when ChatGPT is the brain.
const BOTH = BRAIN === "chatgpt" ? "Claude" : CHATGPT ? "ChatGPT" : null;

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
  // The answer to every step: what was done, the picture, and the numbered list. The list costs many
  // tokens (thousands of characters, sent again with every click and key), so after a step only what
  // changed is sent; app_look and app_open always send it whole. A line that is the same (number, kind,
  // name, value, place) still means the same thing; numbers shift -> too many changes -> the whole list.
  let lastList = null; // { name, lines } last sent in this task
  const show = (r, cmd) => {
    if (!r?.ok) return { content: [{ type: "text", text: String(r?.why || "It did not work.") }], isError: true };
    const lines = [];
    if (r.did) lines.push(r.did);
    lines.push(`Program: ${r.name}${r.title && r.title !== r.name ? ` - window title "${r.title}"` : ""}. Picture: ${r.image.w} x ${r.image.h} pixels (x to the right, y down, from the top-left corner).`);
    if (r.front === false) lines.push("Note: the program could not be brought to the front, so something may cover it in the picture.");
    for (const p of r.popups || []) lines.push(`Also open: a window "${p.title}" at (${p.x}, ${p.y}), ${p.w} x ${p.h}.`);
    if (r.items?.length) {
      const now = r.items.map((it) => {
        const extra = it.password ? " [password box - never type into it]" : it.value !== undefined && it.value !== "" ? ` value="${it.value}"` : "";
        return `${it.n}. ${it.kind} "${it.name}"${extra}${it.disabled ? " (disabled)" : ""} at ${it.x},${it.y} ${it.w}x${it.h}`;
      });
      const before = cmd !== "look" && cmd !== "open" && lastList?.name === r.name ? new Set(lastList.lines) : null;
      const kept = before ? new Set(now) : null;
      const added = before ? now.filter((l) => !before.has(l)) : now;
      const gone = before ? lastList.lines.filter((l) => !kept.has(l)).length : 0;
      lastList = { name: r.name, lines: now };
      if (before && !added.length && !gone) lines.push("", "Things on screen: the same list as before (same numbers).");
      else if (before && added.length + gone <= Math.max(8, now.length * 0.3)) {
        lines.push("", `Things on screen: only the changes since the last list (every other number is as before)${gone ? `; ${gone} thing(s) from it are gone` : ""}. New or changed:`, ...added);
      } else lines.push("", "Things on screen (click by number; x,y = top-left corner, then width x height):", ...now);
      if (r.complete === false) lines.push("(The list may be incomplete: the program was slow to describe itself.)");
    } else {
      lastList = null;
      lines.push("", "This program lists nothing it can be clicked by (it draws everything itself, like Blender or a game). Use the picture: click by x and y, and use its keyboard shortcuts.");
    }
    return { content: [{ type: "text", text: lines.join("\n") }, { type: "image", data: r.image.data, mimeType: r.image.type || "image/png" }] };
  };
  const run = (cmd, pick) => async (a) => { try { return show(await step(cmd, pick ? pick(a) : a), cmd); } catch (e) { return fail(e); } };
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

  // ----- no mouse: background controls and bridges -----
  server.registerTool("app_act", {
    title: "Use a control without the mouse",
    description: "Press, fill in (set), tick (toggle), pick (select), open (expand) or close (collapse) a thing from the app_look list through Windows accessibility - without moving the mouse or using the keyboard. Prefer it to app_click whenever the thing is listed. Returns a new picture.",
    inputSchema: {
      target: z.number().int().min(1).describe("The number of the thing from the app_look list"),
      action: z.enum(["press", "set", "toggle", "select", "expand", "collapse", "show", "focus"]).optional().describe("Default press. set = replace a text box's (or slider's) value with value; show = scroll it into view"),
      value: z.string().max(20000).optional().describe("For set: the new text or number"),
      ...wait,
    },
  }, run("act"));
  const kindName = (r) => `${r.name} (${r.kind === "craft" ? (r.live ? "live bridge to the open window" : "headless bridge: works on files, not on the window") : `Python bridge, live in ${r.kind === "blender" ? "Blender" : "Krita"}`})`;
  const asText = (r, text) => (r?.ok ? { content: [{ type: "text", text: text(r) }] } : { content: [{ type: "text", text: String(r?.why || "It did not work.") }], isError: true });
  server.registerTool("app_commands", {
    title: "The program's own commands",
    description: "What the program in the middle can be told to do from the inside, with no mouse (its bridge). Craft apps list their commands (filter by a word; name = one command's full parameters). Blender and Krita answer that they take Python (app_python) and describe their open file.",
    inputSchema: {
      filter: z.string().max(200).optional().describe("Only commands whose name or description contains this"),
      name: z.string().max(200).optional().describe("One command's exact name: its full description and parameters"),
    },
  }, async (a) => {
    try {
      const r = await step("bridge", a || {});
      return asText(r, (x) => {
        if (x.python) return `${kindName(x)}.\nIt takes Python: use app_python. ${x.kind === "blender" ? "bpy is ready." : "Krita.instance() is ready as `app`."}\nNow: ${JSON.stringify(x.about)}`;
        if (x.tool) return `${kindName(x)}: ${x.tool.name}\n${x.tool.description}\n\nParameters (JSON schema):\n${JSON.stringify(x.tool.input, null, 2)}`;
        const rows = x.tools.map((t) => `- ${t.name}(${t.params.map((p) => (t.required.includes(p) ? p : `${p}?`)).join(", ")}): ${t.description}`);
        return `${kindName(x)}: ${x.total} commands${x.filter ? `, ${x.tools.length + x.more} matching "${x.filter}"` : ""}${x.more ? ` (first ${x.tools.length} shown; filter to see others)` : ""}. Use app_command to run one; app_commands with name shows one's full parameters.\n${rows.join("\n")}`;
      });
    } catch (e) { return fail(e); }
  });
  server.registerTool("app_command", {
    title: "Run one of the program's commands",
    description: "Run one of the program's own commands (from app_commands) through its bridge - no mouse. In a Craft app with a live bridge you see the change in the open window. The answer is the command's result (text, and pictures when it renders).",
    inputSchema: {
      command: z.string().min(1).max(200).describe("The command's name from app_commands"),
      params: z.record(z.string(), z.any()).optional().describe("Its parameters, as app_commands describes them"),
    },
  }, async (a) => {
    try {
      const r = await step("bridge-call", { command: a.command, params: a.params || {} });
      if (!r?.ok) return { content: [{ type: "text", text: String(r?.why || "It did not work.") }], isError: true };
      const content = (r.content || []).map((x) => (x.type === "image" ? { type: "image", data: x.data, mimeType: x.mimeType || "image/png" } : { type: "text", text: String(x.text ?? "") }));
      return { content: content.length ? content : [{ type: "text", text: "Done (no output)." }] };
    } catch (e) { return fail(e); }
  });
  server.registerTool("app_python", {
    title: "Run Python inside Blender or Krita",
    description: "Run Python inside the live Blender (bpy) or Krita (Krita.instance() as `app`) in the middle of AI Brain - no mouse; you see the change in the program. Variables stay between calls. What you print comes back, and so does the value of a last expression. It is checked like a command (the user may have to allow it).",
    inputSchema: { code: z.string().min(1).max(100000).describe("The Python code") },
  }, async (a) => {
    try {
      if (BRAIN === "chatgpt") { // Claude is asked through --permission-prompt-tool; ChatGPT through this
        const no = await mayRun("mcp__ai-brain__app_python", { code: a.code });
        if (no) return no;
      }
      const r = await step("python", { code: a.code });
      return asText(r, (x) => `${kindName(x)}\n${x.output ? `Printed:\n${x.output}\n` : ""}${x.result != null ? `Result: ${x.result}` : x.output ? "" : "Done (nothing printed, no result)."}`);
    } catch (e) { return fail(e); }
  });
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

if (BRAIN === "chatgpt") server.registerTool(
  "ask_claude",
  {
    title: "Ask Claude",
    description:
      "Send a message to Claude (the user's Claude login via Claude Code) and get its reply. Claude is strong at careful " +
      "reasoning, writing and code review. It has no tools here (it cannot read files: put what it needs in the message). " +
      "Continues the same conversation unless new_conversation is true.",
    inputSchema: {
      prompt: z.string().describe("The message to send"),
      new_conversation: z.boolean().optional().describe("Start a fresh conversation"),
    },
  },
  async ({ prompt, new_conversation }) => {
    try { return text((await askClaude(prompt, { newConversation: new_conversation })).text); } catch (e) { return fail(e); }
  }
);

if (BOTH) server.registerTool(
  "ask_both",
  {
    title: `Ask ${BOTH} and Gemini`,
    description: `Send the same message to ${BOTH} and Gemini at the same time and return both replies.`,
    inputSchema: {
      prompt: z.string().describe("The message to send to both"),
      new_conversation: z.boolean().optional().describe("Start fresh conversations"),
    },
  },
  async ({ prompt, new_conversation }) => {
    const opts = { newConversation: new_conversation };
    const [c, g] = await Promise.allSettled([BOTH === "Claude" ? askClaude(prompt, opts) : askChatGPT(prompt, opts), askGemini(prompt, opts)]);
    const show = (r) => (r.status === "fulfilled" ? r.value.text : `ERROR: ${r.reason?.message || r.reason}`);
    return text(`=== ${BOTH} ===\n${show(c)}\n\n=== Gemini ===\n${show(g)}`);
  }
);

server.registerTool(
  "reset_conversations",
  {
    title: "Reset conversations",
    description: `Forget the ongoing conversations with the helpers so the next message starts fresh. Transcripts stay in ${LOGS}.`,
    inputSchema: {},
  },
  async () => { resetConversations(); return text("Conversations reset."); }
);

// Permission check. Claude calls this (through --permission-prompt-tool) before it changes a file or
// runs a command. It asks the AI Brain window and waits for the user's click. Anything that goes
// wrong (app gone, no answer, bad reply) counts as "no".
const APPROVE_URL = process.env.AI_BRAIN_APPROVE_URL;
const APPROVE_KEY = process.env.AI_BRAIN_APPROVE_KEY;
/** Ask the AI Brain window whether this step may run: { behavior: "allow" } or { behavior: "deny", message }. */
function askUser(tool_name, input, tool_use_id = "") {
  return new Promise((resolve, reject) => {
    const u = new URL(APPROVE_URL);
    const body = JSON.stringify({ tool_name, input: input ?? {}, tool_use_id });
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
}
// Claude asks through this tool (--permission-prompt-tool). ChatGPT's own file and command tools are
// switched off; it gets the tools below instead, and each one asks the same way before it acts.
if (BRAIN === "claude" && APPROVE_URL && APPROVE_KEY) server.registerTool(
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
      const reply = await askUser(args.tool_name, args.input, args.tool_use_id || "");
      if (reply?.behavior === "allow") return text(JSON.stringify({ behavior: "allow", updatedInput: args.input ?? {} }));
      return no(String(reply?.message || "The user did not allow this."));
    } catch {
      return no("AI Brain could not ask the user, so this was not allowed.");
    }
  }
);

// ---------- the ChatGPT brain's files and commands ----------
// Codex runs with its own shell and file tools switched off (read-only sandbox, no shell), so these are
// its only way to read, change and run things. Same rules as Claude: reading only inside the working
// folder and the folders the user gave; every change and command goes through the approval check
// (asks the user, or "always allow"), and sign-in data and AI Brain's keys are never touched.
let FOLDERS = [WORK];
try { const f = JSON.parse(process.env.AI_BRAIN_FOLDERS || "[]"); if (Array.isArray(f)) FOLDERS = [WORK, ...f.filter((x) => typeof x === "string")]; } catch { /* only the workspace */ }
const within = (child, parent) => { const r = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase()); return r === "" || (!!r && !r.startsWith("..") && !path.isAbsolute(r)); };
/** The full path, or throws when it is outside the allowed folders or off limits. */
function allowedPath(p) {
  if (typeof p !== "string" || !p.trim()) throw new Error("Give a file path.");
  const full = path.resolve(WORK, p.trim());
  if (forbidden({ p: full })) throw new Error("Not allowed: AI Brain never lets the brain touch sign-in data or its own keys.");
  // Follow links, so a link inside the workspace cannot lead outside it.
  let real = full;
  try { real = fs.realpathSync.native(full); } catch { try { real = path.join(fs.realpathSync.native(path.dirname(full)), path.basename(full)); } catch { /* new folder */ } }
  if (!FOLDERS.some((f) => within(full, f) && within(real, f))) throw new Error(`Not allowed: only files inside ${FOLDERS.join("; ")} can be used.`);
  return full;
}
/** null when the step may run, otherwise the tool answer that says why not. */
async function mayRun(tool, input) {
  if (!APPROVE_URL || !APPROVE_KEY) return fail("File and command access is switched off in AI Brain's Settings (Read only). Tell the user what you wanted to do; they can switch it on in Settings > The brain.");
  try {
    const r = await askUser(tool, input);
    return r?.behavior === "allow" ? null : fail(`Not done: ${r?.message || "the user did not allow it."} Do not try the same thing another way; tell the user what you wanted to do and why.`);
  } catch { return fail("AI Brain could not ask the user, so this was not done."); }
}
const MAX_READ = 200_000;
const IMG_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
if (BRAIN === "chatgpt") {
  server.registerTool("read_file", {
    title: "Read a file",
    description: "Read a text file (or look at a picture: png, jpg, webp, gif) inside your working folder or the folders the user gave you, such as files the user attached. Relative paths start in the working folder. Long files: read part of it with offset (first line, from 1) and limit (number of lines).",
    inputSchema: {
      path: z.string().describe("The file's full path, or a path relative to the working folder"),
      offset: z.number().int().min(1).optional().describe("First line to read (from 1)"),
      limit: z.number().int().min(1).optional().describe("How many lines to read"),
    },
  }, async (a) => {
    try {
      const full = allowedPath(a.path);
      const st = fs.statSync(full);
      if (st.isDirectory()) return fail("That is a folder: use list_folder.");
      const ext = path.extname(full).toLowerCase();
      if (IMG_TYPES[ext]) {
        if (st.size > 15 * 1024 * 1024) return fail("That picture is too big to look at (over 15 MB).");
        return { content: [{ type: "text", text: `${full} (${st.size} bytes)` }, { type: "image", data: fs.readFileSync(full).toString("base64"), mimeType: IMG_TYPES[ext] }] };
      }
      if (MEDIA_RE.test(full)) return text(`${full} is a video (${st.size} bytes); it cannot be read as text.`);
      if (st.size > 20 * 1024 * 1024) return fail("That file is too big to read (over 20 MB).");
      const buf = fs.readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) return text(`${full} is not a text file (${st.size} bytes).`);
      const lines = buf.toString("utf8").split(/\r?\n/);
      const from = (a.offset || 1) - 1, to = a.limit ? from + a.limit : lines.length;
      let out = lines.slice(from, to).map((l, i) => `${from + i + 1}\t${l}`).join("\n");
      let note = "";
      if (out.length > MAX_READ) { out = out.slice(0, MAX_READ); note = `\n… (cut at ${MAX_READ} characters: read the rest with offset and limit)`; }
      return text(`${full} - lines ${from + 1}-${Math.min(to, lines.length)} of ${lines.length}\n${out}${note}`);
    } catch (e) { return fail(e.code === "ENOENT" ? "That file does not exist." : e); }
  });
  server.registerTool("list_folder", {
    title: "List a folder",
    description: "List what is inside a folder (inside your working folder or the folders the user gave you). Relative paths start in the working folder.",
    inputSchema: { path: z.string().optional().describe("The folder (default: the working folder)") },
  }, async (a) => {
    try {
      const full = allowedPath(a.path || WORK);
      const items = fs.readdirSync(full, { withFileTypes: true });
      const rows = items.slice(0, 500).map((d) => {
        if (d.isDirectory()) return `[folder] ${d.name}`;
        let size = "";
        try { size = ` (${fs.statSync(path.join(full, d.name)).size} bytes)`; } catch { /* gone */ }
        return `${d.name}${size}`;
      });
      return text(`${full}\n${rows.join("\n") || "(empty)"}${items.length > 500 ? `\n… and ${items.length - 500} more` : ""}`);
    } catch (e) { return fail(e.code === "ENOENT" ? "That folder does not exist." : e); }
  });
}
// The change tools exist only while File and command access allows changes (like Claude's Write, Edit
// and PowerShell): in "Read only" the app gives no approval key.
if (BRAIN === "chatgpt" && APPROVE_URL && APPROVE_KEY) {
  server.registerTool("write_file", {
    title: "Write a file",
    description: "Create a file, or replace a whole file, with this text (inside your working folder or the folders the user gave you). The user may have to allow it first.",
    inputSchema: { path: z.string().describe("The file's full path, or a path relative to the working folder"), content: z.string().describe("The whole new text of the file") },
  }, async (a) => {
    try {
      const full = allowedPath(a.path);
      const no = await mayRun("Write", { file_path: full, content: a.content });
      if (no) return no;
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, a.content);
      return text(`Wrote ${full} (${Buffer.byteLength(a.content)} bytes).`);
    } catch (e) { return fail(e); }
  });
  server.registerTool("edit_file", {
    title: "Change part of a file",
    description: "Replace one exact piece of text in a file with new text. old_string must match the file exactly and only once (or set replace_all). The user may have to allow it first.",
    inputSchema: {
      path: z.string().describe("The file's full path, or a path relative to the working folder"),
      old_string: z.string().min(1).describe("The exact text to replace"),
      new_string: z.string().describe("The text to put in its place"),
      replace_all: z.boolean().optional().describe("Replace every match (default: only one match allowed)"),
    },
  }, async (a) => {
    try {
      const full = allowedPath(a.path);
      let now;
      try { now = fs.readFileSync(full, "utf8"); } catch { return fail("That file does not exist: use write_file to create it."); }
      const n = now.split(a.old_string).length - 1;
      if (!n) return fail("old_string is not in the file (it must match exactly, spaces and line ends too). Read the file again.");
      if (n > 1 && !a.replace_all) return fail(`old_string is in the file ${n} times: give more of the text around it, or set replace_all.`);
      const no = await mayRun("Edit", { file_path: full, old_string: a.old_string, new_string: a.new_string, replace_all: !!a.replace_all });
      if (no) return no;
      if (fs.readFileSync(full, "utf8") !== now) return fail("The file changed while waiting for the user: read it again.");
      fs.writeFileSync(full, a.replace_all ? now.split(a.old_string).join(a.new_string) : now.replace(a.old_string, () => a.new_string));
      return text(`Changed ${full} (${a.replace_all ? n : 1} place${(a.replace_all ? n : 1) > 1 ? "s" : ""}).`);
    } catch (e) { return fail(e); }
  });
  server.registerTool("run_command", {
    title: "Run a PowerShell command",
    description: "Run a Windows PowerShell command in your working folder and get its output (stops after 10 minutes). The user may have to allow it first. Use it for things the other tools cannot do (searching many files, running programs, git, npm...).",
    inputSchema: { command: z.string().min(1).describe("The PowerShell command"), description: z.string().optional().describe("In a few words: what it is for") },
  }, async (a) => {
    const no = await mayRun("PowerShell", { command: a.command, description: a.description || "" });
    if (no) return no;
    // The command never sees AI Brain's keys.
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^AI_BRAIN_|^BRAIN_/i.test(k)));
    return new Promise((resolve) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", a.command], { cwd: WORK, env, windowsHide: true });
      let out = "", cut = false;
      const add = (d) => { if (out.length < 60_000) out += d; else cut = true; };
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", add); child.stderr.on("data", add);
      child.stdin.end();
      const timer = setTimeout(() => { cut = true; spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }); }, 10 * 60_000);
      child.on("error", (e) => { clearTimeout(timer); resolve(fail(`The command could not start: ${e.message}`)); });
      child.on("close", (code) => {
        clearTimeout(timer);
        const body = `${out.trim() || "(no output)"}${cut ? "\n… (output cut, or stopped after 10 minutes)" : ""}`;
        resolve({ content: [{ type: "text", text: `Exit code ${code}\n${body}` }], ...(code ? { isError: true } : {}) });
      });
    });
  });
}

// ---------- Gemini edits a file (either brain) ----------
// Gemini's own file tools cannot be held to a folder (tested: it wrote outside the folder it was given,
// and an "allow only these folders" rule blocked everything). So Gemini only WRITES THE TEXT, in a
// read-only run, and AI Brain saves it: same folders, same off-limits check, same Allow / Deny.
/** A short "what changes" view: the lines before and after, without the unchanged start and end. */
function changeView(before, after) {
  const a = before.split(/\r?\n/), b = after.split(/\r?\n/);
  let top = 0;
  while (top < a.length && top < b.length && a[top] === b[top]) top++;
  let end = 0;
  while (end < a.length - top && end < b.length - top && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const gone = a.slice(top, a.length - end), added = b.slice(top, b.length - end);
  const clip = (lines, mark) => (lines.length > 400 ? [...lines.slice(0, 400), `${mark} … (${lines.length - 400} more lines)`] : lines).map((l) => `${mark} ${l}`);
  return { gone: gone.length, added: added.length, text: [`From line ${top + 1}:`, ...clip(gone, "-"), ...clip(added, "+")].join("\n") };
}
if (APPROVE_URL && APPROVE_KEY) server.registerTool("gemini_edit_file", {
  title: "Gemini edits a file",
  description: "Have GEMINI change (or create) one text file: give the file and what to change. Gemini writes the new version, " +
    "then the user approves the change like any other (files inside your working folder or the folders the user gave you). " +
    "Use it when the user wants Gemini to make the change, or when Gemini is the better fit. For big files, prefer your own edits.",
  inputSchema: {
    path: z.string().describe("The file's full path, or a path relative to the working folder (a new file is created)"),
    instructions: z.string().min(1).describe("What Gemini should change, clearly and completely"),
  },
}, async (a) => {
  try {
    const full = allowedPath(a.path);
    let before = "", exists = false;
    try {
      const buf = fs.readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) return fail("That is not a text file, so Gemini cannot edit it.");
      before = buf.toString("utf8"); exists = true;
    } catch (e) { if (e.code !== "ENOENT") throw e; }
    if (before.length > 150_000) return fail("That file is too big for Gemini to rewrite (over 150,000 characters). Make the change yourself with edit_file or Edit.");
    const tag = Math.random().toString(36).slice(2, 10);
    const prompt = [
      "You are editing ONE file for the AI Brain app. Do not use any tools and do not change any file yourself: just write the new text.",
      `File: ${full}${exists ? "" : " (it does not exist yet: write all of it)"}`,
      `What to change: ${a.instructions}`,
      "", "The file now, between the two marker lines:", `<<<FILE_${tag}`, before, `FILE_${tag}>>>`,
      "", `Reply with the COMPLETE new text of the file between a line <<<NEW_${tag} and a line NEW_${tag}>>> (no code fences around it), then at most one short sentence on what you changed.`,
    ].join("\n");
    const r = await askGemini(prompt, { standalone: true });
    const m = r.text.match(new RegExp(`<<<NEW_${tag}\\r?\\n([\\s\\S]*?)\\r?\\nNEW_${tag}>>>`));
    if (!m) return fail(`Gemini did not send the new file, so nothing changed. Gemini said:\n${r.text.slice(0, 1500)}`);
    let after = m[1];
    if (/^```[^\n]*\n[\s\S]*\n```$/.test(after) && !before.startsWith("```")) after = after.replace(/^```[^\n]*\n/, "").replace(/\n```$/, "");
    if (before.endsWith("\n") && !after.endsWith("\n")) after += "\n";
    if (before.includes("\r\n")) after = after.replace(/\r?\n/g, "\r\n");
    const said = r.text.slice(r.text.indexOf(`NEW_${tag}>>>`) + tag.length + 7).trim().slice(0, 300);
    if (exists && after === before) return text(`Gemini made no change to ${full}.${said ? ` Gemini said: ${said}` : ""}`);
    const view = changeView(before, after);
    const no = await mayRun("GeminiEdit", { file_path: full, content: after, change: exists ? view.text : "", instructions: a.instructions, created: !exists });
    if (no) return no;
    let now = "";
    try { now = fs.readFileSync(full, "utf8"); } catch { /* still new */ }
    if (now !== before) return fail("The file changed while Gemini was working or while waiting for the user, so Gemini's version was not saved. Read it and try again.");
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, after);
    return text(`${exists ? `Gemini changed ${full}: ${view.gone} line(s) out, ${view.added} line(s) in.` : `Gemini created ${full} (${after.split("\n").length} lines).`}${said ? `\nGemini said: ${said}` : ""}`);
  } catch (e) { return fail(e); }
});

await server.connect(new StdioServerTransport());
