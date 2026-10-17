import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import { DpiError } from "../../dpi-sdk/src/errors.js";
import { openAICompatibleConfig } from "../src/openai-compatible.js";
import { bootServer, newToken, tempStore } from "./helpers.js";

const body = async (req: IncomingMessage) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || "{}");
};

/** A fake LiteLLM: streams one chat/completions answer and records each request. */
async function fakeOpenAI() {
  const calls: { auth?: string; model: string; path: string }[] = [];
  const server = createServer(async (req, res) => {
    const json = await body(req);
    calls.push({ auth: req.headers.authorization, model: json.model, path: req.url ?? "" });
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: json.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk({ role: "assistant", content: `hi from ${json.model}` }));
    res.write(chunk({}, "stop"));
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { base, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("openai-compatible config: required env, defaults, validation", () => {
  assert.throws(() => openAICompatibleConfig({ DPI_MODELS: "a" }), /OPENAI_BASE_URL/);
  assert.throws(() => openAICompatibleConfig({ OPENAI_BASE_URL: "http://x/v1" }), /DPI_MODELS/);
  assert.throws(
    () => openAICompatibleConfig({ OPENAI_BASE_URL: "http://x/v1", DPI_MODELS: "a", DPI_DEFAULT_MODEL: "b" }),
    /not in DPI_MODELS/,
  );
  const c = openAICompatibleConfig({ OPENAI_BASE_URL: "http://x/v1/", DPI_MODELS: " a, b ,a" });
  assert.deepEqual(c, { baseUrl: "http://x/v1", models: ["a", "b"], defaultModel: "a", contextWindow: 32768, maxTokens: 8192 });
});

test("openai-compatible provider: lists DPI_MODELS and routes every call to OPENAI_BASE_URL", async () => {
  const t = await tempStore();
  const llm = await fakeOpenAI();
  const token = newToken();
  const server = await bootServer({
    home: join(t.root, "home"),
    startDirs: t.work,
    token,
    env: {
      DPI_PROVIDER: "openai-compatible",
      OPENAI_BASE_URL: llm.base,
      OPENAI_API_KEY: "sk-placeholder",
      DPI_MODELS: "qwen3.8-flash-next,local-default",
      OPENROUTER_API_KEY: "",
    },
  });
  try {
    const client = new DpiClient(server.base, token);
    const info = await client.device();
    assert.deepEqual(info.models.map((m) => [m.provider, m.id]), [
      ["openai-compatible", "qwen3.8-flash-next"],
      ["openai-compatible", "local-default"],
    ]);
    assert.equal(info.defaultModel, "qwen3.8-flash-next");
    await assert.rejects(
      () => client.createSession({ name: "x", cwd: t.work, model: { provider: "openrouter", modelId: "anthropic/claude-sonnet-5.5" } }),
      (e: DpiError) => e.code === "invalid",
    );
    await client.createSession({ name: "lab", cwd: t.work, model: { provider: "openai-compatible", modelId: "local-default" } });
    const answer = await client.agent("lab", "main").send("hello", "followUp", "req-1", 15000);
    assert.equal(answer.status === "done" && answer.answer.text, "hi from local-default");
    assert.ok(llm.calls.length >= 1);
    for (const call of llm.calls) {
      assert.equal(call.path, "/v1/chat/completions");
      assert.equal(call.auth, "Bearer sk-placeholder");
    }
  } finally {
    await server.stop();
    await llm.close();
    await t.cleanup();
  }
});
