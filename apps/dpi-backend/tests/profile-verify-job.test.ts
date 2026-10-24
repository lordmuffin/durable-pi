// profile-verify (jobs.ts): the durable job end to end against fake Forgejo, dashboard, LiteLLM and ntfy servers --
// confirming it never touches the real network and reaches App State /gpu/<node>:<profile>:<date>.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { Store } from "../src/store.js";
import { JOB_RUNS_DOC, type JobRunsDoc } from "../../dpi-sdk/src/jobs.js";
import { faux, tempStore, until } from "./helpers.js";

const CATALOG = `schema: gpu-workloads/v1
node: andrew-gamingpc
namespace: jarvis
gpu: {resource: amd.com/gpu, count: 1, vram_gib: 16, reserve_gib: 1}
active_profile: ollama
workloads:
  ollama: {deployment: ollama, manifest: manifests/30-ollama-deployment.yaml, gpus: 1, vram_gib: 12}
profiles:
  "off": []
  ollama: [ollama]
`;

async function fakeServer(handler: (req: { method: string; path: string; body?: any }, reply: (status: number, v: unknown) => void) => void) {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url!, "http://x");
    const body = raw ? (() => { try { return JSON.parse(raw); } catch { return raw; } })() : undefined;
    handler({ method: req.method!, path: url.pathname + url.search, body }, (status, v) =>
      void res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(v)),
    );
  });
  server.listen(0);
  await once(server, "listening");
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

const jobs = async (store: Store, session: string) => {
  const { h, c } = await store.resolveAgent(session, "main");
  return (await store.agentDoc(h, c, JOB_RUNS_DOC)) as JobRunsDoc;
};
const startJob = async (store: Store, session: string, job: string, input: Record<string, unknown> = {}) => {
  const m = await store.resolveAgent(session, "main");
  return (await store.startJob(m.row, m.h, m.c, { job, input })).taskId;
};

test("profile-verify waits for the PR to merge and converge, checks readiness and models, benches, then reports", async () => {
  const forgejo = await fakeServer((req, reply) => {
    if (req.path === "/api/v1/repos/o/r/pulls/7") return reply(200, { merged: true, state: "closed", merge_commit_sha: "sha1" });
    if (req.path.startsWith("/api/v1/repos/o/r/actions/runs"))
      return reply(200, { workflow_runs: [{ head_sha: "sha1", status: "completed", conclusion: "success", path: "deploy-k3s-andrew-gamingpc.yml" }] });
    if (req.path === "/api/v1/repos/o/r/contents/bare-metal/andrew-gamingpc/workloads.yaml?ref=main")
      return reply(200, { type: "file", path: "bare-metal/andrew-gamingpc/workloads.yaml", name: "workloads.yaml", sha: "s", content: Buffer.from(CATALOG).toString("base64") });
    reply(404, { message: `unhandled ${req.path}` });
  });
  const dashboard = await fakeServer((req, reply) => {
    if (req.path === "/api/nodes/andrew-gamingpc/status") return reply(200, { workloads: { ollama: { ready: true } } });
    reply(404, { message: "unhandled" });
  });
  const litellm = await fakeServer((req, reply) => {
    if (req.path === "/chat/completions" && req.body?.model === "ollama")
      return reply(200, { choices: [{ message: { content: "hi there" } }], usage: { completion_tokens: req.body.max_tokens } });
    reply(500, { message: "unhandled" });
  });
  const ntfy = await fakeServer((_req, reply) => reply(200, {}));

  const saved = {
    GITOPS_API: process.env.GITOPS_API,
    GITOPS_REPO: process.env.GITOPS_REPO,
    GITOPS_TOKEN: process.env.GITOPS_TOKEN,
    DASHBOARD_API: process.env.DASHBOARD_API,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    NTFY_URL: process.env.NTFY_URL,
  };
  Object.assign(process.env, {
    GITOPS_API: `${forgejo.base}/api/v1`,
    GITOPS_REPO: "o/r",
    GITOPS_TOKEN: "tok",
    DASHBOARD_API: dashboard.base,
    OPENAI_BASE_URL: litellm.base,
    OPENAI_API_KEY: "test-key",
    NTFY_URL: `${ntfy.base}/infra_alerts`,
  });

  const t = await tempStore();
  const store = await t.open();
  try {
    const session = await store.create({ name: "Verify", cwd: t.work, model: faux });
    const run = await startJob(store, session.id, "profile-verify", { node: "andrew-gamingpc", profile: "ollama", pr_number: 7, models: "ollama" });
    await until(async () => (await jobs(store, session.id)).items[run]?.status === "completed", 20000, "profile-verify completion");
    const record = (await jobs(store, session.id)).items[run];
    assert.deepEqual(record.phases.map((p) => p.status), ["done", "done", "done", "done"]);
    assert.match(record.result ?? "", /Saved to App State \/gpu\/andrew-gamingpc:ollama:/);

    const state = (await store.deviceDoc("app.shared-state")).value as { gpu?: Record<string, { node: string; profile: string; models: string[] }> };
    const [key, entry] = Object.entries(state.gpu ?? {})[0]!;
    assert.match(key, /^andrew-gamingpc:ollama:\d{4}-\d{2}-\d{2}$/);
    assert.equal(entry.node, "andrew-gamingpc");
    assert.equal(entry.profile, "ollama");
    assert.deepEqual(entry.models, ["ollama"]);
  } finally {
    await store.close();
    await t.cleanup();
    forgejo.close();
    dashboard.close();
    litellm.close();
    ntfy.close();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
