// gitops.ts: path and content rules for propose_fix, and its Forgejo calls against a fake server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { applyEdit, checkContent, fingerprintOf, gitopsConfig, proposeFix, writePath, type GitopsConfig } from "../src/gitops.js";

test("writePath: only apps/ and clusters/k3s2/ manifests, never Flux bootstrap or secrets", () => {
  for (const p of ["apps/ai/jev/release.yaml", "clusters/k3s2/ai/jev.yaml", "/apps/services/gotify/README.md"]) assert.ok(writePath(p));
  for (const [p, why] of [
    ["clusters/k3s2/flux-system/gotk-sync.yaml", /flux-system/],
    ["apps/secrets/foo.yaml", /apps\/secrets/],
    ["apps/ai/jev/secret.sops.yaml", /SOPS/],
    ["apps/../clusters/k3s2/x.yaml", /Invalid path/],
    ["opentofu-core-services/main.tf", /may only touch/],
    ["apps/ai/jev/run.sh", /\.yaml/],
    ["clusters/other/x.yaml", /may only touch/],
  ] as const)
    assert.throws(() => writePath(p), why, p);
});

test("checkContent rejects Secrets and keys, allows secret references", () => {
  assert.throws(() => checkContent("a.yaml", "apiVersion: v1\nkind: Secret\nstringData:\n  x: y\n"), /OnePasswordItem/);
  assert.throws(() => checkContent("a.yaml", "key: |\n  -----BEGIN OPENSSH PRIVATE KEY-----\n"), /keys/);
  checkContent("a.yaml", "apiVersion: onepassword.com/v1\nkind: OnePasswordItem\nspec:\n  itemPath: vaults/HomeLab/items/x\n");
  checkContent("a.yaml", "secretRef:\n  name: shpa-git-auth\n");
});

test("applyEdit needs exactly one match", () => {
  assert.equal(applyEdit("f", "tag: v1\nname: a\n", "tag: v1", "tag: v2"), "tag: v2\nname: a\n");
  assert.throws(() => applyEdit("f", "a\na\n", "a", "b"), /more than once/);
  assert.throws(() => applyEdit("f", "a\n", "z", "b"), /not found/);
});

test("fingerprintOf and gitopsConfig", () => {
  assert.equal(fingerprintOf("inc-1cf0a72e-20261023t1206"), "1cf0a72e");
  assert.equal(fingerprintOf("manual"), undefined);
  assert.equal(gitopsConfig({}), undefined);
  assert.deepEqual(gitopsConfig({ GITOPS_API: "https://git.apj.dev/api/v1/", GITOPS_REPO: "o/r", GITOPS_TOKEN: "t" }), {
    api: "https://git.apj.dev/api/v1", repo: "o/r", token: "t", base: "main", maxOpen: 5,
  });
});

/** A fake Forgejo holding one repo's main branch in memory. */
async function fakeForgejo(files: Record<string, string>) {
  const state = { files, pulls: [] as { number: number; html_url: string; head: { ref: string } }[], calls: [] as { method: string; path: string; body?: any }[], auth: [] as string[] };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const url = new URL(req.url!, "http://x");
    const path = url.pathname.replace("/api/v1/repos/o/r", "");
    const body = raw ? JSON.parse(raw) : undefined;
    state.calls.push({ method: req.method!, path, body });
    state.auth.push(String(req.headers.authorization));
    const json = (status: number, v: unknown) => void res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(v));
    if (req.method === "GET" && path.startsWith("/contents/")) {
      const p = decodeURIComponent(path.slice("/contents/".length));
      if (!(p in state.files)) return json(404, { message: "not found" });
      return json(200, { type: "file", path: p, name: p, sha: `sha-${p}`, content: Buffer.from(state.files[p]).toString("base64") });
    }
    if (req.method === "GET" && path === "/pulls") return json(200, state.pulls);
    if (req.method === "POST" && path === "/contents") return json(201, { commit: { sha: "c1" } });
    if (req.method === "POST" && path === "/pulls") {
      const pr = { number: 700 + state.pulls.length, html_url: `https://git.apj.dev/o/r/pulls/${700 + state.pulls.length}`, head: { ref: body.head } };
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

test("proposeFix opens one PR, then comments on it when the same alert fires again, and stops at the cap", async () => {
  const f = await fakeForgejo({ "apps/x/gitrepo.yaml": "spec:\n  secretRef:\n    name: shpa-git-auth\n" });
  try {
    const args = {
      incident_id: "inc-1cf0a72e-20261023t1206",
      title: "Add OnePasswordItem for shpa-git-auth",
      rationale: "The secret is missing.",
      creates: [{ path: "apps/x/onepassworditem.yaml", content: "kind: OnePasswordItem" }],
      person_must: "Create HomeLab/shpa-git-auth in 1Password",
    };
    const r1 = await proposeFix(f.cfg, args, { session: "abcdef1234" });
    assert.deepEqual(r1, { kind: "opened", number: 700, url: "https://git.apj.dev/o/r/pulls/700", branch: "jev/inc-1cf0a72e-20261023t1206" });
    const commit = f.state.calls.find((c) => c.method === "POST" && c.path === "/contents")!.body;
    assert.equal(commit.new_branch, "jev/inc-1cf0a72e-20261023t1206");
    assert.equal(commit.branch, "main");
    assert.deepEqual(commit.files.map((x: any) => [x.operation, x.path]), [["create", "apps/x/onepassworditem.yaml"]]);
    const pr = f.state.calls.find((c) => c.method === "POST" && c.path === "/pulls")!.body;
    assert.match(pr.body, /a person must:\*\* Create HomeLab\/shpa-git-auth/);
    assert.ok(f.state.auth.every((a) => a === "token tok"));

    const r2 = await proposeFix(f.cfg, { ...args, incident_id: "inc-1cf0a72e-20261023t1300" }, { session: "abcdef1234" });
    assert.equal(r2.kind, "commented");
    assert.equal(r2.number, 700);
    assert.equal(f.state.pulls.length, 1);

    const edit = { incident_id: "inc-22222222-x", title: "t", rationale: "r", edits: [{ path: "apps/x/gitrepo.yaml", old_string: "shpa-git-auth", new_string: "shpa-git-auth-v2" }] };
    const r3 = await proposeFix(f.cfg, edit, { session: "s" });
    assert.equal(r3.kind, "opened");
    const update = f.state.calls.filter((c) => c.method === "POST" && c.path === "/contents")[1].body.files[0];
    assert.equal(update.operation, "update");
    assert.equal(update.sha, "sha-apps/x/gitrepo.yaml");
    assert.match(Buffer.from(update.content, "base64").toString(), /name: shpa-git-auth-v2/);

    await assert.rejects(proposeFix(f.cfg, { ...edit, incident_id: "inc-33333333-x" }, { session: "s" }), /already open \(limit 2\)/);
  } finally {
    f.close();
  }
});

test("proposeFix rejects the whole fix before pushing when any change is bad", async () => {
  const f = await fakeForgejo({ "apps/x/a.yaml": "a: 1\n" });
  try {
    const base = { incident_id: "inc-44444444-x", title: "t", rationale: "r" };
    await assert.rejects(proposeFix(f.cfg, { ...base, edits: [{ path: "apps/x/a.yaml", old_string: "a: 1", new_string: "a: 2" }], creates: [{ path: "apps/x/s.yaml", content: "kind: Secret\n" }] }, { session: "s" }), /no kind: Secret/);
    await assert.rejects(proposeFix(f.cfg, { ...base, edits: [{ path: "apps/x/missing.yaml", old_string: "a", new_string: "b" }] }, { session: "s" }), /does not exist/);
    await assert.rejects(proposeFix(f.cfg, { ...base, creates: [{ path: "apps/x/a.yaml", content: "b" }] }, { session: "s" }), /already exists/);
    await assert.rejects(proposeFix(f.cfg, { ...base, edits: [{ path: "clusters/k3s2/flux-system/x.yaml", old_string: "a", new_string: "b" }] }, { session: "s" }), /flux-system/);
    await assert.rejects(proposeFix(f.cfg, base, { session: "s" }), /Nothing to change/);
    assert.ok(!f.state.calls.some((c) => c.method === "POST"), "nothing was written");
  } finally {
    f.close();
  }
});
