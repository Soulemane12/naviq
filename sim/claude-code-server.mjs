// Claude Code as NAVIQ's model backend: a local stand-in for the Anthropic Messages API.
//
// NAVIQ's server already talks to Claude through @anthropic-ai/sdk.  Point it here and each request is
// answered by Claude Code in headless mode (`claude -p`) under your own Claude Code login:
//
//   node sim/claude-code-server.mjs            # listens on 127.0.0.1:8789 (CLAUDE_CODE_PORT)
//   ANTHROPIC_BASE_URL=http://127.0.0.1:8789 ANTHROPIC_API_KEY=claude-code PROVIDER=anthropic npm start
//
// Only what NAVIQ uses is supported: one user turn (images + text), a system prompt, effort, and
// output_config.format (JSON schema), which becomes `claude --json-schema`.  Measured on a plaque frame:
// ~2-2.8 s per call, ~1 s of it model time.  Voice (/api/tts) still needs OpenAI.
//
// Each call is a fresh `claude -p` with no tools, no MCP servers, no settings (so no hooks) and no saved
// session.  ANTHROPIC_LOG, ANTHROPIC_BASE_URL and ANTHROPIC_API_KEY are removed from its environment so it
// uses your login and can't call back into this server.

import http from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";

const PORT = Number(process.env.CLAUDE_CODE_PORT ?? 8789);
const MAX_PARALLEL = Number(process.env.CLAUDE_CODE_PARALLEL ?? 3); // NAVIQ keeps at most 2 looks in flight
const TIMEOUT_MS = Number(process.env.CLAUDE_CODE_TIMEOUT_MS ?? 30000);
const CLAUDE = process.env.CLAUDE_BIN ?? "claude";
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

const childEnv = { ...process.env };
for (const k of ["ANTHROPIC_LOG", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) delete childEnv[k];

let running = 0;
const waiting = [];
const slot = () => (running < MAX_PARALLEL ? (running++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
const release = () => (waiting.length ? waiting.shift()() : running--);

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

/** Messages API request body → the claude CLI's arguments and its one stream-json input line. */
export function toClaudeCall(body) {
  const user = (body.messages ?? []).filter((m) => m.role === "user");
  if (user.length !== 1) throw Object.assign(new Error("only one user message is supported"), { status: 400 });
  const system = typeof body.system === "string" ? body.system : (body.system ?? []).map((b) => b.text ?? "").join("\n");
  const effort = body.output_config?.effort;
  const schema = body.output_config?.format?.schema;
  const args = ["-p", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--setting-sources", "",
    "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  if (body.model) args.push("--model", body.model);
  if (EFFORTS.has(effort)) args.push("--effort", effort);
  if (system) args.push("--system-prompt", system);
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  const content = typeof user[0].content === "string" ? [{ type: "text", text: user[0].content }] : user[0].content;
  const input = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
  return { args, input, wantsJson: Boolean(schema) };
}

/** The claude CLI's final `result` event → a Messages API response. */
export function toMessage(result, model, wantsJson) {
  const text = wantsJson && result.structured_output != null ? JSON.stringify(result.structured_output) : String(result.result ?? "");
  return {
    id: `msg_cc_${result.uuid ?? Date.now()}`,
    type: "message",
    role: "assistant",
    model: model ?? "claude-code",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: result.usage?.input_tokens ?? 0, output_tokens: result.usage?.output_tokens ?? 0 },
  };
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function runClaude({ args, input }) {
  return new Promise((resolve, reject) => {
    const p = spawn(CLAUDE, args, { env: childEnv, cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`claude timed out after ${TIMEOUT_MS} ms`)); }, TIMEOUT_MS);
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      const result = out.split("\n").reverse().map(parseLine).find((e) => e?.type === "result");
      if (!result) return reject(new Error(`claude exited ${code} without a result: ${(err || out).trim().slice(-300)}`));
      if (result.is_error) return reject(new Error(`claude: ${String(result.result).slice(0, 300)}`));
      resolve(result);
    });
    p.stdin.end(input);
  });
}

function reply(res, status, obj) {
  // x-should-retry: false keeps the SDK from silently re-running a slow failed call twice more.
  res.writeHead(status, { "content-type": "application/json", ...(status >= 400 ? { "x-should-retry": "false" } : {}) });
  res.end(JSON.stringify(obj));
}

const apiError = (status, message) => ({ type: "error", error: { type: status === 400 ? "invalid_request_error" : "api_error", message } });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/health") return reply(res, 200, { ok: true, running, waiting: waiting.length });
  if (req.method !== "POST" || url.pathname !== "/v1/messages") return reply(res, 404, apiError(404, "not found"));
  let body;
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return reply(res, 400, apiError(400, "bad JSON"));
  }
  let call;
  try {
    call = toClaudeCall(body);
  } catch (e) {
    return reply(res, e.status ?? 400, apiError(e.status ?? 400, e.message));
  }
  const t0 = Date.now();
  await slot();
  const queuedMs = Date.now() - t0;
  try {
    const result = await runClaude(call);
    log(`ok ${Date.now() - t0} ms (queued ${queuedMs}, model ${result.duration_api_ms ?? "?"}) ${body.model ?? ""} → ${String(result.result).slice(0, 80)}`);
    reply(res, 200, toMessage(result, body.model, call.wantsJson));
  } catch (e) {
    log(`error ${Date.now() - t0} ms: ${e.message}`);
    reply(res, 502, apiError(502, e.message));
  } finally {
    release();
  }
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  server.listen(PORT, "127.0.0.1", () => log(`Claude Code backend on http://127.0.0.1:${PORT} (max ${MAX_PARALLEL} at once)`));
}
