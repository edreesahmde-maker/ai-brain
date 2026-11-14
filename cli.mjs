#!/usr/bin/env node
// Quick manual test:  node cli.mjs chatgpt "hello"   |   node cli.mjs gemini "hello"   |   node cli.mjs both "hello"
import { askChatGPT, askGemini } from "./lib.mjs";

const [who, ...rest] = process.argv.slice(2);
const prompt = rest.join(" ");
if (!who || !prompt) {
  console.error('Usage: node cli.mjs <chatgpt|gemini|both> "message"');
  process.exit(1);
}
const run = async (name, fn) => {
  try { const r = await fn(prompt); console.log(`=== ${name} ===\n${r.text}\n`); }
  catch (e) { console.log(`=== ${name} ERROR ===\n${e.message}\n`); }
};
if (who === "chatgpt" || who === "both") await run("ChatGPT", askChatGPT);
if (who === "gemini" || who === "both") await run("Gemini", askGemini);
