// Homelab additions: homelab-guard (hard-deny, fail-closed Jev), the homelab-incident tools and approve-irreversible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { join } from "node:path";
import type { JobRunsDoc } from "../../dpi-sdk/src/jobs.js";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import { DpiError } from "../../dpi-sdk/src/errors.js";
import { hardDeny } from "../src/guard.js";
import { k8sArgv } from "../src/incident.js";
import { parseJevAnswers } from "../src/jev.js";
import { BASH_QUESTIONS } from "../src/addons.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

test("hard-deny: the fixed list, and near misses that stay allowed", () => {
  for (const cmd of [
    "tofu apply",
    "tofu -chdir=opentofu-core-services/pve plan && tofu -chdir=opentofu-core-services/pve apply -auto-approve",
    "terraform apply plan.out",
    "sudo zpool create vmdata /dev/sdb",
    "zpool destroy tank",
    "git push origin main",
    "git push origin HEAD:main",
    "git push origin HEAD:refs/heads/main",
    "git push -f origin feat/x",
    "git push --force-with-lease origin feat/x",
    "git push -uf origin feat/x",
    "git push origin +feat/x",
    "kubectl delete pod pi-durable-0 -n pi-durable",
    "kubectl -n flux-system delete kustomization apps",
    "echo ok; kubectl \\\n  delete ns x",
  ])
    assert.ok(hardDeny(cmd), `should deny: ${cmd}`);
  for (const cmd of [
    "tofu plan",
    "zpool status",
    "zpool status pool-destroy-test",
    "git push origin feat/main-fix",
    "git push -u origin feat/x",
    "git push origin feat/x && echo main",
    "kubectl get pods -A",
    "kubectl describe deploy delete-me",
    "flux get kustomizations",
    "echo 'kubectl' && echo delete",
  ])
    assert.equal(hardDeny(cmd), undefined, `should allow: ${cmd}`);
});

test("k8s_read builds argv from allow-listed parts only", () => {
  assert.deepEqual(k8sArgv({ tool: "flux", resource: "kustomizations", all_namespaces: true }).argv, ["get", "kustomizations", "--all-namespaces"]);
  assert.deepEqual(k8sArgv({ tool: "flux", resource: "sources git", name: "flux-system", namespace: "flux-system" }).argv, ["get", "sources", "git", "flux-system", "-n", "flux-system"]);
  assert.deepEqual(k8sArgv({ tool: "kubectl", verb: "logs", resource: "pods", name: "pi-durable-0", namespace: "pi-durable", tail: 50, previous: true }).argv, ["logs", "pi-durable-0", "-n", "pi-durable", "--tail=50", "--previous"]);
  assert.deepEqual(k8sArgv({ tool: "kubectl", verb: "get", resource: "pods", namespace: "a", selector: "app=x", output: "wide" }).argv, ["get", "pods", "-n", "a", "-l", "app=x", "-o", "wide"]);
  assert.throws(() => k8sArgv({ tool: "kubectl", verb: "delete" as "get", resource: "pods" }), /verbs/);
  assert.throws(() => k8sArgv({ tool: "kubectl", resource: "secrets" }), /Unsupported resource/);
  assert.throws(() => k8sArgv({ tool: "kubectl", resource: "pods", name: "x; rm -rf /" }), /Invalid name/);
  assert.throws(() => k8sArgv({ tool: "kubectl", resource: "pods", namespace: "--kubeconfig=/x" }), /Invalid namespace/);
  assert.throws(() => k8sArgv({ tool: "kubectl", verb: "describe", resource: "pods", output: "yaml" }), /output applies to get only/);
  assert.throws(() => k8sArgv({ tool: "flux", resource: "reconcile" }), /flux get supports/);
});

test("Jev chat answers: strict parsing so a fail-closed caller never guesses", () => {
  const ok = parseJevAnswers('{"effect":{"choice":"read_only","confidence":0.9},"destructive_intent":{"noul":0.1}}', BASH_QUESTIONS);
  assert.deepEqual(ok.effect, { type: "choice", choice: "read_only", confidence: 0.9, probabilities: { read_only: 0.9 } });
  assert.throws(() => parseJevAnswers('{"effect":{"choice":"maybe","confidence":1},"destructive_intent":{"noul":0}}', BASH_QUESTIONS), /missing: effect/);
  assert.throws(() => parseJevAnswers('{"effect":{"choice":"read_only","confidence":1}}', BASH_QUESTIONS), /missing: destructive_intent/);
  assert.throws(() => parseJevAnswers("not json", BASH_QUESTIONS));
});

/** A fake LiteLLM serving only the `jev` model; `mode` decides its verdicts. */
async function fakeJev() {
  const state = { mode: "allow" as "allow" | "down", calls: 0 };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    state.calls++;
    if (state.mode === "down") return void res.writeHead(503).end();
    const body = JSON.parse(raw);
    const command = String(JSON.parse(body.messages[1].content).command);
    const irreversible = /\brm\s+-rf\b/.test(command);
    const content = JSON.stringify({
      effect: { choice: irreversible ? "irreversible" : "read_only", confidence: 0.95 },
      destructive_intent: { noul: irreversible ? 0.9 : 0.05 },
    });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { base, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("homelab-guard: hard-deny first, Jev next, fail closed; incident tools; approve-irreversible", async () => {
  const t = await tempStore();
  const jev = await fakeJev();
  const token = newToken();
  const server = await bootServer({
    home: join(t.root, "home"),
    startDirs: t.work,
    token,
    env: { DPI_GUARD: "on", JEV_BASE_URL: jev.base, OPENAI_API_KEY: "sk-placeholder" },
  });
  try {
    const client = new DpiClient(server.base, token);
    const s = await client.createSession({ name: "guarded", cwd: t.work, model: faux });
    const main = client.agent(s.id, "main");
    const lastTool = async () => {
      const entry = (await main.entries({ scope: "all" })).items.find((e) => e.kind === "pi.tool-result");
      return JSON.stringify(entry?.model);
    };
    const bash = async (cmd: string, id: string) => {
      assert.equal((await main.send(`!${cmd}`, "followUp", id, 20000)).status, "done");
      return lastTool();
    };

    // The guard is selected for every agent and the Extend tab cannot remove it.
    assert.ok((await main.extensions()).builtIn.includes("homelab-guard"));
    await assert.rejects(() => main.setExtension({ name: "homelab-guard", enabled: false }), (e: DpiError) => e.code === "invalid");

    // 1. Hard-deny never asks Jev.
    const before = jev.state.calls;
    assert.match(await bash("kubectl delete pod pi-durable-0", "b1"), /homelab-guard hard-deny/);
    assert.equal(jev.state.calls, before, "hard-deny decides without Jev");
    // 2. Jev allows a read-only command and blocks a destructive one, pointing at the approval job.
    assert.match(await bash("echo guarded-ok", "b2"), /guarded-ok/);
    assert.match(await bash("rm -rf ./scratch", "b3"), /homelab-guard blocked this command.*approve-irreversible/);
    // 3. Jev down: fail closed.
    jev.state.mode = "down";
    assert.match(await bash("echo should-not-run", "b4"), /Jev is unreachable/);
    jev.state.mode = "allow";

    // Incident sessions: the extension plus Read only leaves the read tools and exactly the three incident tools.
    await main.setExtension({ name: "homelab-incident", enabled: true });
    await main.configure({ readOnly: true });
    const offered = (await main.get()).tools.filter((x) => x.offered).map((x) => x.name);
    for (const name of ["k8s_read", "save_rca", "notify"]) assert.ok(offered.includes(name), name);
    for (const name of ["bash", "write", "edit", "update_state", "run_durable_job"]) assert.ok(!offered.includes(name), name);
    await main.configure({ readOnly: false });

    // approve-irreversible: hard-denied input fails in Request; a normal command waits for approval, then runs once.
    const runs = async () => (await main.doc<JobRunsDoc>("demo.job-runs")).value.items;
    const denied = await main.demo<{ taskId: number }>("jobs", { job: "approve-irreversible", input: { command: "kubectl delete ns x", reason: "test" } });
    await until(async () => (await runs())[denied.taskId]?.status === "failed", 15000, "hard-denied run fails");
    const job = await main.demo<{ taskId: number }>("jobs", { job: "approve-irreversible", input: { command: "echo approved > approved.txt", reason: "test" } });
    await until(async () => (await runs())[job.taskId]?.approval === "pending", 15000, "approval pending");
    await client.request("POST", `/v1/sessions/${s.id}/agents/main/demo/jobs/${job.taskId}/approval`, { approved: true });
    await until(async () => (await runs())[job.taskId]?.status === "completed", 15000, "approved run completes");
  } finally {
    await server.stop();
    await jev.close();
    await t.cleanup();
  }
});
