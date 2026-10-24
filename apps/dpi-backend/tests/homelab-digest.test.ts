// homelab-digest: collect (validated kubectl/flux reads, no shell) -> compare (App State /digest/previous) ->
// interpret (one tool-free model call) -> publish (App State + one ntfy line). See docs/pi-durable.md (homelab repo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { once } from "node:events";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import type { JobRunsDoc } from "../../dpi-sdk/src/jobs.js";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

const FAKE_KUBECTL = join(import.meta.dirname, "fixtures/fake-kubectl.mjs");

type Call = { url: string; method: string; body: string; headers: Record<string, string> };

/** A minimal HTTP stand-in for LiteLLM / ntfy: records every call, `reply` decides the response. */
async function fakeHttp(reply: () => { status: number; body: string }) {
  const calls: Call[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    calls.push({ url: req.url ?? "", method: req.method ?? "GET", body: raw, headers: req.headers as Record<string, string> });
    const { status, body } = reply();
    res.writeHead(status, { "content-type": "application/json" }).end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { base, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Stands in for nfsd/rpcbind: a bare TCP listener is enough for tcpProbe's connect/timeout race. */
async function fakePort() {
  const server = createTcpServer((sock) => sock.end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let closed = false;
  return {
    port: (server.address() as { port: number }).port,
    close: () =>
      new Promise<void>((r) => {
        if (closed) return r();
        closed = true;
        server.close(() => r());
      }),
  };
}

async function setup(openaiReply: () => { status: number; body: string }, opts: { nfsHealthy?: boolean; b2Stale?: boolean } = {}) {
  await chmod(FAKE_KUBECTL, 0o755);
  const openai = await fakeHttp(openaiReply);
  const ntfy = await fakeHttp(() => ({ status: 200, body: "{}" }));
  const healthy = opts.nfsHealthy ?? true;
  // Healthy: real listeners. Unhealthy: close them right away, so 127.0.0.1:<port> refuses every connect.
  const nfsd = await fakePort();
  const rpcbind = await fakePort();
  if (!healthy) await Promise.all([nfsd.close(), rpcbind.close()]);
  const t = await tempStore();
  const token = newToken();
  const server = await bootServer({
    home: join(t.root, "home"),
    startDirs: t.work,
    token,
    env: {
      KUBECTL_BIN: FAKE_KUBECTL,
      OPENAI_BASE_URL: `${openai.base}/v1`,
      OPENAI_API_KEY: "test",
      NTFY_URL: `${ntfy.base}/infra_alerts`,
      DIGEST_NFS_HOST: "127.0.0.1",
      DIGEST_NFS_PORT: String(nfsd.port),
      DIGEST_RPCBIND_PORT: String(rpcbind.port),
      ...(opts.b2Stale ? { FAKE_B2_MODE: "stale" } : {}),
    },
  });
  const client = new DpiClient(server.base, token);
  return {
    client,
    server,
    openai,
    ntfy,
    cleanup: async () => {
      await server.stop();
      await Promise.all([openai.close(), ntfy.close(), nfsd.close(), rpcbind.close(), t.cleanup()]);
    },
  };
}

const okReply = () => ({
  status: 200,
  body: JSON.stringify({ choices: [{ message: { content: "All green. Nothing needs a person tonight." } }] }),
});

test("homelab-digest appears in the device's job list with its phases and model input", async () => {
  const f = await setup(okReply);
  try {
    const def = (await f.client.device()).jobs?.find((j) => j.id === "homelab-digest");
    assert.ok(def, "homelab-digest is listed");
    assert.deepEqual(def!.phases.map((p) => p.id), ["collect", "compare", "interpret", "publish"]);
    assert.equal(def!.inputs.find((i) => i.name === "model")?.default, "qwen3.8-flash-next");
  } finally {
    await f.cleanup();
  }
});

test("homelab-digest: collects every section without a shell, calls the model once with no tools, publishes, notifies once", async () => {
  const f = await setup(okReply);
  try {
    const s = await f.client.createSession({ name: "digest", cwd: (await tempStore()).work, model: faux });
    const main = f.client.agent(s.id, "main");
    const { taskId } = await main.demo<{ taskId: number }>("jobs", { job: "homelab-digest", input: { model: "qwen3.8-flash-next" } });
    const run = async () => (await main.doc<JobRunsDoc>("demo.job-runs")).value.items[taskId];
    await until(async () => (await run())?.status === "completed", 20000, "digest completion");
    const done = await run();
    assert.deepEqual(done.phases.map((p) => p.status), ["done", "done", "done", "done"]);

    // collect: every section is present and healthy with this fixture.
    const collectSteps = done.phases[0].steps.filter((st) => st.kind === "tool");
    assert.deepEqual(
      collectSteps.map((st) => st.label),
      ["Velero Backups (24h)", "CNPG / barman status", "B2 offsite backup", "NFS reachability", "Harbor cache stats", "Flux readiness", "Pods not Ready >1h"],
    );
    for (const st of collectSteps) assert.equal(st.status, "done", st.label);

    // interpret: exactly one call to the model endpoint, no tool-call shape in the request.
    assert.equal(f.openai.calls.length, 1);
    const sent = JSON.parse(f.openai.calls[0].body);
    assert.equal(sent.model, "qwen3.8-flash-next");
    assert.equal(sent.tools, undefined);

    // publish: one ntfy line, low priority since nothing needs a person.
    assert.equal(f.ntfy.calls.length, 1);
    assert.equal(f.ntfy.calls[0].url, "/infra_alerts");
    assert.equal(f.ntfy.calls[0].headers.priority, "min");

    // App State carries both the dated snapshot and /digest/previous.
    const state = (await f.client.deviceDoc("app.shared-state")).value as { digest?: Record<string, unknown> };
    assert.ok(state.digest?.previous, "digest.previous saved");
    const dated = Object.keys(state.digest ?? {}).filter((k) => k !== "previous");
    assert.equal(dated.length, 1, "exactly one dated snapshot");
  } finally {
    await f.cleanup();
  }
});

test("homelab-digest: a failing section is reported, not hidden, and still publishes with higher-priority notify", async () => {
  const f = await setup(okReply, { nfsHealthy: false, b2Stale: true });
  try {
    const t = await tempStore();
    const s = await f.client.createSession({ name: "digest-fail", cwd: t.work, model: faux });
    const main = f.client.agent(s.id, "main");
    const { taskId } = await main.demo<{ taskId: number }>("jobs", { job: "homelab-digest", input: {} });
    const run = async () => (await main.doc<JobRunsDoc>("demo.job-runs")).value.items[taskId];
    await until(async () => (await run())?.status === "completed", 20000, "digest completion");
    const done = await run();
    assert.equal(done.status, "completed", "a section needing attention still completes the run, not fails it");
    const nfsStep = done.phases[0].steps.find((st) => st.label === "NFS reachability");
    assert.equal(nfsStep?.status, "done", "the probe itself succeeds even though NFS is unreachable");
    assert.match(nfsStep?.detail ?? "", /NAS UNREACHABLE/);
    const b2Step = done.phases[0].steps.find((st) => st.label === "B2 offsite backup");
    assert.match(b2Step?.detail ?? "", /STALE/);
    assert.equal(f.ntfy.calls.length, 1);
    assert.equal(f.ntfy.calls[0].headers.priority, "default", "needs-a-person digest is not low priority");
  } finally {
    await f.cleanup();
  }
});

test("SIGKILL mid-collect: a restart re-runs collect cleanly and the digest still publishes", async () => {
  const f = await setup(okReply);
  try {
    const t = await tempStore();
    const s = await f.client.createSession({ name: "digest-crash", cwd: t.work, model: faux });
    const main = f.client.agent(s.id, "main");
    const { taskId } = await main.demo<{ taskId: number }>("jobs", { job: "homelab-digest", input: { model: "qwen3.8-flash-next" } });
    const run = async () => (await main.doc<JobRunsDoc>("demo.job-runs")).value.items[taskId];
    // Wait for at least one collect step to land, then kill before the phase (and so the run) can finish.
    await until(async () => ((await run())?.phases[0].steps.length ?? 0) >= 1, 15000, "first collect step");
    await f.server.stop("SIGKILL");
    await f.server.start();
    await until(async () => (await run())?.status === "completed", 20000, "completion after SIGKILL");
    const done = await run();
    assert.deepEqual(done.phases.map((p) => p.status), ["done", "done", "done", "done"]);
    assert.ok(done.resumed >= 1, "the run recorded at least one resume");
    // Exactly one ntfy post even though collect's idempotent reads ran twice (once interrupted, once clean).
    assert.equal(f.ntfy.calls.length, 1);
  } finally {
    await f.cleanup();
  }
});
