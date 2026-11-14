#!/usr/bin/env node
// TEST ONLY. Plays the part of the Claude CLI: reads the task from stdin and prints
// stream-json events shaped like the real ones. Markers in the task pick the scenario:
//   [tool]  ask Gemini, then answer      [image] make an image, then answer
//   [both]  ask ChatGPT and Gemini       [error] finish with an error result
//   [hang]  start answering, never end   [crash] exit with an error before answering
//   [long]  long Markdown answer         [xss]   answer full of unsafe HTML
//   [slow]  slower typing
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const resume = arg("--resume");
const model = arg("--model") || "default";
const DATA = process.env.BRAIN_DATA_DIR || process.cwd();
const MEDIA = path.join(DATA, "workspace", "media");
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

// The argument log lets tests check exactly how the brain was started.
try { fs.appendFileSync(path.join(DATA, "fake-claude-args.jsonl"), JSON.stringify({ args, prompt }) + "\n"); } catch {}

if (resume === "stale-session") {
  out({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["No conversation found with session ID: stale-session"], session_id: "none" });
  process.exit(1);
}

const session_id = resume || `fake-${crypto.randomBytes(6).toString("hex")}`;
const has = (m) => prompt.toLowerCase().includes(`[${m}]`);
const stream = (event) => out({ type: "stream_event", event, parent_tool_use_id: null, session_id });
const speed = has("slow") ? 60 : 12;

async function say(text, { thinking = false } = {}) {
  if (thinking) {
    stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    await sleep(150);
    stream({ type: "content_block_stop", index: 0 });
  }
  stream({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  for (let i = 0; i < text.length; i += 9) {
    stream({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(i, i + 9) } });
    await sleep(speed);
  }
  stream({ type: "content_block_stop", index: 1 });
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] }, session_id });
}
async function tool(name, input, resultText, isError = false, wait = 500) {
  const id = `toolu_${crypto.randomBytes(8).toString("hex")}`;
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] }, session_id });
  await sleep(wait);
  const text = typeof resultText === "function" ? resultText() : resultText;
  out({ type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: [{ type: "text", text }], is_error: isError }] }, session_id });
  return text;
}
function finish(result, is_error = false) {
  out({
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", unifiedWindows: {
      five_hour: { utilization: 0.42, resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600, status: "allowed" },
      seven_day: { utilization: 0.17, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400, status: "allowed" },
    } },
    session_id,
  });
  out({ type: "result", subtype: is_error ? "error_during_execution" : "success", is_error, result, session_id, usage: { input_tokens: 1200, cache_creation_input_tokens: 300, cache_read_input_tokens: 5000, output_tokens: 340 }, total_cost_usd: 0.0123, num_turns: 2, ...(is_error ? { errors: ["Test error from the fake brain."] } : {}) });
}

out({ type: "system", subtype: "init", session_id, model: `fake-${model}`, tools: ["Read"], mcp_servers: [{ name: "ai-brain", status: "connected" }] });
await sleep(120);

if (has("crash")) {
  process.stderr.write("fake brain: simulated crash\n");
  process.exit(3);
}

if (has("hang")) {
  await say("I am starting to answer and then I will keep going for a very long time");
  await new Promise(() => setInterval(() => {}, 1000));
}

if (has("error")) {
  finish("", true);
  process.exit(1);
}

// [change] writes a file, [command] runs a command, [twice] writes two files; each asks the app first,
// exactly like the real approve tool does. [forbidden] aims at Discord's data, [badkey] uses a wrong key.
async function askUser(tool_name, input) {
  const env = JSON.parse(fs.readFileSync(arg("--mcp-config"), "utf8")).mcpServers["ai-brain"].env;
  if (!env.AI_BRAIN_APPROVE_URL) return { behavior: "deny", message: "no approve tool" };
  const r = await fetch(env.AI_BRAIN_APPROVE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: new URL(env.AI_BRAIN_APPROVE_URL).origin, "X-Brain-Key": has("badkey") ? "x".repeat(48) : env.AI_BRAIN_APPROVE_KEY },
    body: JSON.stringify({ tool_name, input, tool_use_id: "toolu_fake" }),
  });
  return r.json();
}
async function guarded(name, input, run) {
  const id = `toolu_${crypto.randomBytes(8).toString("hex")}`;
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] }, session_id });
  const ans = await askUser(name, input);
  const allowed = ans.behavior === "allow";
  if (allowed) run();
  out({ type: "user", message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content: [{ type: "text", text: allowed ? "done" : ans.message }], is_error: !allowed }] }, session_id });
  return allowed ? "allowed" : `denied (${ans.message})`;
}
if (has("change") || has("command") || has("twice")) {
  const results = [];
  if (has("command")) results.push(await guarded("PowerShell", { command: "Get-Date -Format yyyy", description: "Show the year" }, () => {}));
  else {
    const files = has("twice") ? ["fake-change-1.txt", "fake-change-2.txt"] : ["fake-change.txt"];
    for (const f of files) {
      const file = has("forbidden") ? "C:\\Users\\me\\AppData\\Roaming\\discord\\Local Storage\\leveldb\\x.log" : path.join(process.cwd(), f);
      results.push(await guarded("Write", { file_path: file, content: "hello from the brain" }, () => fs.writeFileSync(file, "hello from the brain")));
    }
  }
  await say(`Results: ${results.join("; ")}`);
  finish(`Results: ${results.join("; ")}`);
  process.exit(0);
}

if (has("tool")) {
  await say("Let me ask Gemini about that.", { thinking: true });
  const r = await tool("mcp__ai-brain__ask_gemini", { prompt: "Give me three ideas for: " + prompt.slice(0, 80) }, "1. First idea\n2. Second idea\n3. Third idea");
  const text = `Gemini suggested three ideas:\n\n${r}\n\nMy pick is the **second** one.`;
  await say(text);
  finish(text);
} else if (has("image")) {
  const r = await tool("mcp__ai-brain__generate_image", { description: "A test picture, golden clover on black" }, () => {
    const src = process.env.BRAIN_FAKE_IMAGE;
    if (!src) return "ERROR: no test image configured";
    const dest = path.join(MEDIA, `${Date.now().toString(36)}-brain_image${path.extname(src)}`);
    fs.copyFileSync(src, dest);
    return `Image created.\n\nSaved files:\n${dest}`;
  });
  const file = r.split("\n").pop();
  const text = `Here is your picture.\n\nSaved to: ${file}`;
  await say(text);
  finish(text);
} else if (has("both")) {
  await tool("mcp__ai-brain__ask_both", { prompt: "What is your favourite colour?" }, "=== ChatGPT ===\nBlue, like a clear sky.\n\n=== Gemini ===\nERROR: Gemini test failure.");
  const text = "ChatGPT said blue. Gemini could not answer this time.";
  await say(text);
  finish(text);
} else if (has("failtool")) {
  await tool("mcp__ai-brain__ask_gemini", { prompt: "This one fails" }, "Gemini (Antigravity CLI) gave no reply.", true);
  const text = "Gemini did not answer, so here is my own answer: 42.";
  await say(text);
  finish(text);
} else if (has("xss")) {
  const text = [
    "Unsafe content test.",
    "",
    '<img src="x" onerror="window.__xss = 1">',
    "<script>window.__xss = 2</script>",
    '<a href="javascript:window.__xss=3">bad link</a>',
    "[md bad link](javascript:window.__xss=4)",
    '<iframe src="https://example.com"></iframe>',
    "![remote image](https://example.com/pixel.png)",
    '<div onclick="window.__xss=5" style="position:fixed;inset:0">overlay</div>',
    "",
    "[a normal link](https://example.com/page)",
  ].join("\n");
  await say(text);
  finish(text);
} else if (has("long")) {
  const text = [
    "# Plan for the launch",
    "",
    "Here is a **complete** plan with _every_ kind of formatting.",
    "",
    "## Steps",
    "",
    "1. Pick a name",
    "2. Draw the logo",
    "3. Tell everyone",
    "",
    "- [x] Budget agreed",
    "- [ ] Venue booked",
    "",
    "| Item | Cost | Owner |",
    "| --- | ---: | --- |",
    "| Logo | $40 | Gemini |",
    "| Flyers | $120 | You |",
    "",
    "```js",
    "function greet(name) {",
    "  return `Hello, ${name}!`;",
    "}",
    "```",
    "",
    "> A quote worth remembering.",
    "",
    "Inline `code`, a [link](https://example.com), and some Arabic: مرحبا بالعالم",
    "",
    ...Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog, again and again, to make this answer long enough to scroll.`).flatMap((p) => [p, ""]),
  ].join("\n");
  await say(text, { thinking: true });
  finish(text);
} else {
  const text = `Fake brain reply to: **${prompt.slice(0, 120).replace(/\s+/g, " ")}**\n\n- model: \`${model}\`\n- resumed: ${resume ? "yes" : "no"}`;
  await say(text, { thinking: true });
  finish(text);
}
process.exit(0);
