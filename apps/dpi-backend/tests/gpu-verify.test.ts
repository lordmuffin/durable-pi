// gpu-verify.ts: the HTTP helpers the profile-verify job polls/checks/benches with, against fakes -- none of these
// touch the cluster or run a shell command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { GitopsConfig } from "../src/gitops.js";
import { chatOnce, fetchNodeStatus, findWorkflowRun, membersReady, pollPrMerged, tokensPerSecond, NODE_WORKFLOWS } from "../src/gpu-verify.js";

test("NODE_WORKFLOWS names the deploy workflow for each workload-swap node", () => {
  assert.deepEqual(NODE_WORKFLOWS, {
    "andrew-gamingpc": "deploy-k3s-andrew-gamingpc.yml",
    "lxc-k3s2-gpu-a": "deploy-k3s-lxc-k3s2-gpu-a.yml",
  });
});

test("membersReady reports which workloads are not ready, under workloads, roles or a flat payload", () => {
  assert.deepEqual(membersReady({ workloads: { a: { ready: true }, b: { status: "Running" } } }, ["a", "b"]), { ready: true, detail: "ready: a, b" });
  assert.deepEqual(membersReady({ roles: { a: { replicas_ready: 1 } } }, ["a"]), { ready: true, detail: "ready: a" });
  assert.deepEqual(membersReady({ a: { ready: false } }, ["a", "b"]), { ready: false, detail: "not ready: a, b" });
  assert.deepEqual(membersReady({}, []), { ready: true, detail: "ready: (none)" });
});

test("tokensPerSecond needs a successful call with completion tokens and positive elapsed time", () => {
  assert.equal(tokensPerSecond({ ok: true, ms: 2000, completionTokens: 10 }), 5);
  assert.equal(tokensPerSecond({ ok: false, ms: 100, completionTokens: 10 }), undefined);
  assert.equal(tokensPerSecond({ ok: true, ms: 100, completionTokens: undefined }), undefined);
  assert.equal(tokensPerSecond({ ok: true, ms: 0, completionTokens: 10 }), undefined);
});

async function fakeServer(handler: (req: { method: string; path: string; body?: any }, reply: (status: number, v: unknown) => void) => void) {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url!, "http://x");
    handler({ method: req.method!, path: url.pathname + url.search, body: raw ? JSON.parse(raw) : undefined }, (status, v) =>
      void res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(v)),
    );
  });
  server.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => server.close() };
}

test("pollPrMerged and findWorkflowRun read Forgejo's PR and Actions-run APIs", async () => {
  const f = await fakeServer((req, reply) => {
    if (req.path === "/api/v1/repos/o/r/pulls/42") return reply(200, { merged: true, state: "closed", merge_commit_sha: "abc123" });
    if (req.path === "/api/v1/repos/o/r/pulls/43") return reply(200, { merged: false, state: "open" });
    if (req.path.startsWith("/api/v1/repos/o/r/actions/runs"))
      return reply(200, {
        workflow_runs: [
          { head_sha: "abc123", status: "completed", conclusion: "success", path: ".github/workflows/deploy-k3s-andrew-gamingpc.yml" },
          { head_sha: "other", status: "completed", conclusion: "success", path: ".github/workflows/deploy-k3s-andrew-gamingpc.yml" },
        ],
      });
    reply(404, { message: "unhandled" });
  });
  try {
    const cfg: GitopsConfig = { api: `${f.base}/api/v1`, repo: "o/r", token: "tok", base: "main", maxOpen: 5 };
    assert.deepEqual(await pollPrMerged(cfg, 42), { merged: true, state: "closed", mergeCommitSha: "abc123" });
    assert.deepEqual(await pollPrMerged(cfg, 43), { merged: false, state: "open", mergeCommitSha: undefined });
    assert.deepEqual(await findWorkflowRun(cfg, "andrew-gamingpc", "abc123"), { status: "completed", conclusion: "success" });
    assert.equal(await findWorkflowRun(cfg, "andrew-gamingpc", "nope"), undefined);
    await assert.rejects(findWorkflowRun(cfg, "spark-8196", "abc123"), /node must be one of/);
  } finally {
    f.close();
  }
});

test("fetchNodeStatus reads the dashboard's status API and surfaces a non-200 as an error", async () => {
  const f = await fakeServer((req, reply) => {
    if (req.path === "/api/nodes/andrew-gamingpc/status") return reply(200, { workloads: { ollama: { ready: true } } });
    reply(503, { message: "down" });
  });
  try {
    assert.deepEqual(await fetchNodeStatus(f.base, "andrew-gamingpc"), { workloads: { ollama: { ready: true } } });
    await assert.rejects(fetchNodeStatus(f.base, "other-node"), /HTTP 503/);
  } finally {
    f.close();
  }
});

test("chatOnce posts a chat completion and reports elapsed time and tokens, or the HTTP/network error", async () => {
  const f = await fakeServer((req, reply) => {
    if (req.path === "/chat/completions" && req.body.model === "ok")
      return reply(200, { choices: [{ message: { content: "hi" } }], usage: { completion_tokens: 3 } });
    reply(500, { message: "boom" });
  });
  try {
    const ok = await chatOnce(f.base, "key", "ok", "hello", 5);
    assert.equal(ok.ok, true);
    assert.equal(ok.completionTokens, 3);
    assert.equal(ok.text, "hi");

    const bad = await chatOnce(f.base, "key", "bad", "hello", 5);
    assert.equal(bad.ok, false);
    assert.match(bad.error!, /HTTP 500/);

    const unreachable = await chatOnce("http://127.0.0.1:1", "key", "ok", "hello", 5);
    assert.equal(unreachable.ok, false);
  } finally {
    f.close();
  }
});
