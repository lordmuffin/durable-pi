// gpu-profiles.ts: profile/budget validation for propose_profile_change, and its Forgejo calls against a fake server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { GitopsConfig } from "../src/gitops.js";
import { NODE_FILES, checkProfile, profileBudget, proposeProfileChange, setActiveProfile } from "../src/gpu-profiles.js";

const CATALOG = `schema: gpu-workloads/v1
node: andrew-gamingpc
namespace: jarvis
gpu: {resource: amd.com/gpu, count: 1, vram_gib: 16, reserve_gib: 1}
policy: {forbid_toleration_keys: [gaming]}
active_profile: ollama
workloads:
  ollama: {deployment: ollama, manifest: manifests/30-ollama-deployment.yaml, gpus: 1, vram_gib: 12}
  heavy: {deployment: heavy, manifest: manifests/31-heavy-deployment.yaml, gpus: 1, vram_gib: 20}
profiles:
  "off": []
  ollama: [ollama]
  heavy: [heavy]
`;

test("NODE_FILES names exactly the two workload-swap catalogs", () => {
  assert.deepEqual(NODE_FILES, {
    "andrew-gamingpc": "bare-metal/andrew-gamingpc/workloads.yaml",
    "lxc-k3s2-gpu-a": "bare-metal/lxc-k3s2-gpu-a/workloads.yaml",
  });
});

test("checkProfile validates the profile exists, differs from active, and fits the VRAM/GPU budget", () => {
  const b = checkProfile("andrew-gamingpc", CATALOG, "off");
  assert.deepEqual(b, { resource: "amd.com/gpu", count: 1, vram: 16, reserve: 1, gpus: 0, vramSum: 0, members: [], current: "ollama" });

  assert.throws(() => checkProfile("andrew-gamingpc", CATALOG, "nope"), /unknown profile "nope"/);
  assert.throws(() => checkProfile("andrew-gamingpc", CATALOG, "ollama"), /already "ollama"/);
  assert.throws(() => checkProfile("andrew-gamingpc", CATALOG, "heavy"), /needs 20\.0 GiB VRAM but only 15\.0 GiB/);
  assert.throws(() => checkProfile("lxc-k3s2-gpu-a", CATALOG, "off"), /declares node "andrew-gamingpc"/);
});

test("profileBudget allows checking the already-active profile (gpu-verify's post-merge check)", () => {
  const b = profileBudget("andrew-gamingpc", CATALOG, "ollama");
  assert.deepEqual(b, { resource: "amd.com/gpu", count: 1, vram: 16, reserve: 1, gpus: 1, vramSum: 12, members: ["ollama"], current: "ollama" });
  assert.throws(() => checkProfile("andrew-gamingpc", CATALOG, "ollama"), /already "ollama"/);
});

test("checkProfile rejects a profile that over-subscribes the GPU count", () => {
  const doc = CATALOG.replace("heavy: {deployment: heavy, manifest: manifests/31-heavy-deployment.yaml, gpus: 1, vram_gib: 20}", "heavy: {deployment: heavy, manifest: manifests/31-heavy-deployment.yaml, gpus: 2, vram_gib: 4}");
  assert.throws(() => checkProfile("andrew-gamingpc", doc, "heavy"), /needs 2 amd\.com\/gpu but the node budget is 1/);
});

test("setActiveProfile rewrites only the one top-level line", () => {
  const out = setActiveProfile(CATALOG, "off");
  assert.match(out, /^active_profile: off$/m);
  assert.equal(out.replace("active_profile: off", "active_profile: ollama"), CATALOG);
  assert.throws(() => setActiveProfile("workloads: {}\n", "off"), /expected exactly one/);
});

/** A fake Forgejo holding one repo's main branch in memory, shared shape with gitops.test.ts's. */
async function fakeForgejo(files: Record<string, string>) {
  const state = { files, pulls: [] as { number: number; html_url: string; head: { ref: string } }[], calls: [] as { method: string; path: string; body?: any }[] };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url!, "http://x");
    const path = url.pathname.replace("/api/v1/repos/o/r", "");
    const body = raw ? JSON.parse(raw) : undefined;
    state.calls.push({ method: req.method!, path, body });
    const json = (status: number, v: unknown) => void res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(v));
    if (req.method === "GET" && path.startsWith("/contents/")) {
      const p = decodeURIComponent(path.slice("/contents/".length));
      if (!(p in state.files)) return json(404, { message: "not found" });
      return json(200, { type: "file", path: p, name: p, sha: `sha-${p}`, content: Buffer.from(state.files[p]).toString("base64") });
    }
    if (req.method === "GET" && path === "/pulls") return json(200, state.pulls);
    if (req.method === "POST" && path === "/contents") return json(201, { commit: { sha: "c1" } });
    if (req.method === "POST" && path === "/pulls") {
      const pr = { number: 800 + state.pulls.length, html_url: `https://git.apj.dev/o/r/pulls/${800 + state.pulls.length}`, head: { ref: body.head } };
      state.pulls.push(pr);
      return json(201, pr);
    }
    if (req.method === "POST" && /^\/issues\/\d+\/(comments|labels)$/.test(path)) return json(201, {});
    json(404, { message: `unhandled ${req.method} ${path}` });
  });
  server.listen(0);
  await once(server, "listening");
  const cfg: GitopsConfig = { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`, repo: "o/r", token: "tok", base: "main", maxOpen: 2 };
  return { state, cfg, close: () => server.close() };
}

test("proposeProfileChange opens one PR, comments on a repeat request, and stops at the cap", async () => {
  const f = await fakeForgejo({ "bare-metal/andrew-gamingpc/workloads.yaml": CATALOG });
  try {
    const args = { node: "andrew-gamingpc", profile: "off", reason: "Reclaiming the card for a gaming session." };
    const r1 = await proposeProfileChange(f.cfg, args, { session: "abcdef1234" });
    assert.equal(r1.kind, "opened");
    assert.equal(r1.number, 800);
    assert.match(r1.branch!, /^jev\/gpu-andrew-gamingpc-\d{8}T\d{6}$/);
    const commit = f.state.calls.find((c) => c.method === "POST" && c.path === "/contents")!.body;
    assert.equal(commit.files[0].path, "bare-metal/andrew-gamingpc/workloads.yaml");
    assert.equal(commit.files[0].sha, "sha-bare-metal/andrew-gamingpc/workloads.yaml");
    assert.match(Buffer.from(commit.files[0].content, "base64").toString(), /^active_profile: off$/m);
    const pr = f.state.calls.find((c) => c.method === "POST" && c.path === "/pulls")!.body;
    assert.match(pr.title, /andrew-gamingpc: switch GPU profile ollama -> off/);
    assert.match(pr.body, /0 amd\.com\/gpu, 0\.0 GiB VRAM/);
    assert.match(pr.body, /never runs swap\.py, kubectl apply, or gaming-on\/off itself/);

    const r2 = await proposeProfileChange(f.cfg, args, { session: "abcdef1234" });
    assert.equal(r2.kind, "commented");
    assert.equal(r2.number, 800);
    assert.equal(f.state.pulls.length, 1);

    const other = { node: "lxc-k3s2-gpu-a", profile: "off", reason: "test" };
    await assert.rejects(proposeProfileChange(f.cfg, other, { session: "s" }), /does not exist on main/);
  } finally {
    f.close();
  }
});

test("proposeProfileChange rejects an unfit or unknown request before writing anything", async () => {
  const f = await fakeForgejo({ "bare-metal/andrew-gamingpc/workloads.yaml": CATALOG });
  try {
    const base = { node: "andrew-gamingpc" as const, reason: "test" };
    await assert.rejects(proposeProfileChange(f.cfg, { ...base, profile: "heavy" }, { session: "s" }), /needs 20\.0 GiB VRAM/);
    await assert.rejects(proposeProfileChange(f.cfg, { ...base, profile: "nope" }, { session: "s" }), /unknown profile/);
    await assert.rejects(proposeProfileChange(f.cfg, { node: "andrew-gamingpc" as const, profile: "off", reason: "" }, { session: "s" }), /reason is required/);
    assert.ok(!f.state.calls.some((c) => c.method === "POST"), "nothing was written");
  } finally {
    f.close();
  }
});
