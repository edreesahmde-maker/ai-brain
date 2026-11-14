#!/usr/bin/env node
// MCP server: gives Claude tools to talk to ChatGPT (Codex CLI) and Gemini
// (Antigravity CLI) using subscription logins - no API keys. stdout is reserved
// for the MCP protocol - never console.log here.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http from "node:http";
import { askChatGPT, askGemini, generateImage, resetConversations, LOGS } from "./lib.mjs";

// The AI Brain app sets AI_BRAIN_CHATGPT=0 while ChatGPT is switched off in its settings.
const CHATGPT = process.env.AI_BRAIN_CHATGPT !== "0";

const server = new McpServer({ name: "ai-brain", version: "2.1.0" });

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
