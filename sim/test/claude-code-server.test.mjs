// node --test sim/test/   (the "live" test calls Claude Code for real; skip it with NO_LIVE=1)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { toClaudeCall, toMessage } from "../claude-code-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("request → claude args: model, effort, system prompt, schema, one stream-json user line", () => {
  const schema = { type: "object", properties: { rooms: { type: "array", items: { type: "string" } } } };
  const { args, input, wantsJson } = toClaudeCall({
    model: "claude-opus-5-5",
    system: "read signs",
    output_config: { effort: "low", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }, { type: "text", text: "go" }] }],
  });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at("--model"), "claude-opus-5-5");
  assert.equal(at("--effort"), "low");
  assert.equal(at("--system-prompt"), "read signs");
  assert.deepEqual(JSON.parse(at("--json-schema")), schema);
  assert.equal(at("--tools"), "");
  assert.ok(wantsJson);
  const line = JSON.parse(input);
  assert.equal(line.type, "user");
  assert.equal(line.message.content[0].type, "image");
});

test("system given as blocks is joined; unknown effort is dropped", () => {
  const { args } = toClaudeCall({ system: [{ type: "text", text: "a" }, { type: "text", text: "b" }], output_config: { effort: "warp" }, messages: [{ role: "user", content: "hi" }] });
  assert.equal(args[args.indexOf("--system-prompt") + 1], "a\nb");
  assert.ok(!args.includes("--effort"));
});

test("more than one user turn is refused with 400", () => {
  assert.throws(() => toClaudeCall({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }] }), { status: 400 });
});

test("result → message: structured output becomes the text block", () => {
  const m = toMessage({ structured_output: { rooms: ["A105"] }, result: "ignored", uuid: "u1" }, "claude-opus-5-5", true);
  assert.equal(m.content[0].text, '{"rooms":["A105"]}');
  assert.equal(m.stop_reason, "end_turn");
  assert.equal(toMessage({ result: "plain" }, null, false).content[0].text, "plain");
});

test("live: the Anthropic SDK's parse() reads A105 through Claude Code", { skip: process.env.NO_LIVE === "1", timeout: 60000 }, async () => {
  const port = 18789;
  const srv = spawn(process.execPath, [path.join(here, "..", "claude-code-server.mjs")], { env: { ...process.env, CLAUDE_CODE_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      srv.stdout.on("data", (d) => String(d).includes("backend on") && resolve());
      srv.on("exit", (c) => reject(new Error(`server exited ${c}`)));
    });
    const client = new Anthropic({ baseURL: `http://127.0.0.1:${port}`, apiKey: "claude-code", maxRetries: 0 });
    const frame = fs.readFileSync(path.join(here, "plaque-A105.jpg")).toString("base64");
    const t0 = Date.now();
    const r = await client.beta.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      output_config: { effort: "low", format: betaZodOutputFormat(z.object({ rooms: z.array(z.string()) })) },
      system: "You read signs in camera frames for a navigation app. Report only what is visible.",
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame } }, { type: "text", text: "List the room-number plaques you can read." }] }],
    });
    console.log(`  live call ${Date.now() - t0} ms`);
    assert.deepEqual(r.parsed_output.rooms, ["A105"]);
  } finally {
    srv.kill();
  }
});
