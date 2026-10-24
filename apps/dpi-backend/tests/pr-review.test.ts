// pr-review.ts: config gating, the scratch checkout, the offline checks, and the
// post-or-edit-one-comment rule, against a fake Forgejo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { checkout, createPrReview, postOrUpdateComment, reviewConfig, runChecks, type ReviewConfig } from "../src/pr-review.js";

test("reviewConfig: undefined unless all three are set, trailing slash trimmed", () => {
  assert.equal(reviewConfig({}), undefined);
  assert.equal(reviewConfig({ REVIEW_API: "x", REVIEW_REPO: "o/r" }), undefined);
  assert.deepEqual(reviewConfig({ REVIEW_API: "https://git.apj.dev/api/v1/", REVIEW_REPO: "o/r", REVIEW_TOKEN: "t" }), {
    api: "https://git.apj.dev/api/v1", repo: "o/r", token: "t",
  });
});

test("createPrReview offers no tools without a config", () => {
  const ext = createPrReview(undefined);
  assert.deepEqual(ext.tools, []);
});

test("createPrReview offers pr_checks and pr_comment with a config", () => {
  const ext = createPrReview({ api: "http://x/api/v1", repo: "o/r", token: "t" });
  assert.deepEqual(ext.tools?.map((t) => t.name).sort(), ["pr_checks", "pr_comment"]);
});

/** A fake Forgejo: an archive endpoint for `checkout`, and issue-comments for pr_comment. */
async function fakeForgejo(archives: Record<string, Buffer>) {
  const state = { comments: [] as { id: number; body: string }[], calls: [] as { method: string; path: string; body?: any }[], auth: [] as string[] };
  let nextId = 1;
  const server = createServer(async (req, res) => {
    let raw: Buffer[] = [];
    for await (const c of req) raw.push(c as Buffer);
    const url = new URL(req.url!, "http://x");
    const path = url.pathname.replace("/api/v1/repos/o/r", "");
    const body = raw.length && req.headers["content-type"]?.includes("json") ? JSON.parse(Buffer.concat(raw).toString()) : undefined;
    state.calls.push({ method: req.method!, path, body });
    state.auth.push(String(req.headers.authorization));
    const json = (status: number, v: unknown) => void res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(v));
    const m = path.match(/^\/archive\/([0-9a-f]+)\.tar\.gz$/);
    if (req.method === "GET" && m) {
      const buf = archives[m[1]];
      if (!buf) return json(404, { message: "not found" });
      res.writeHead(200, { "Content-Type": "application/gzip" }).end(buf);
      return;
    }
    if (req.method === "POST" && path.match(/^\/issues\/\d+\/comments$/)) {
      const c = { id: nextId++, body: body.body };
      state.comments.push(c);
      return json(201, c);
    }
    if (req.method === "PATCH" && path.match(/^\/issues\/comments\/\d+$/)) {
      const id = Number(path.split("/").pop());
      const c = state.comments.find((x) => x.id === id);
      if (!c) return json(404, { message: "not found" });
      c.body = body.body;
      return json(200, c);
    }
    json(404, { message: `unhandled ${req.method} ${path}` });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const cfg: ReviewConfig = { api: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`, repo: "o/r", token: "tok" };
  return { state, cfg, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** A real gzipped tarball with one file, like Forgejo's /archive/<sha>.tar.gz (top dir stripped by `checkout`). */
async function makeArchive(files: Record<string, string>): Promise<Buffer> {
  const root = await mkdtemp(join(tmpdir(), "pr-review-fixture-"));
  const top = join(root, "o-r-deadbeef");
  await mkdir(top, { recursive: true });
  for (const [p, content] of Object.entries(files)) {
    await mkdir(join(top, p, ".."), { recursive: true });
    await writeFile(join(top, p), content);
  }
  const out = join(root, "out.tar.gz");
  await new Promise<void>((resolve, reject) =>
    execFile("tar", ["czf", out, "-C", root, "o-r-deadbeef"], (err) => (err ? reject(err) : resolve())),
  );
  const buf = await readFile(out);
  await rm(root, { recursive: true, force: true });
  return buf;
}

test("checkout rejects a bad sha without calling Forgejo", async () => {
  await assert.rejects(checkout({ api: "http://x", repo: "o/r", token: "t" }, "not-a-sha"), /Invalid sha/);
});

test("checkout fetches and extracts the PR head archive", async () => {
  const sha = "deadbeefcafe";
  const archive = await makeArchive({ "docs/jev.md": "# jev\n", "apps/ai/jev/kustomization.yaml": "resources: []\n" });
  const f = await fakeForgejo({ [sha]: archive });
  try {
    const dir = await checkout(f.cfg, sha);
    assert.equal((await readFile(join(dir, "docs/jev.md"), "utf8")).trim(), "# jev");
    assert.ok(f.state.auth.every((a) => a === "token tok"));
  } finally {
    await f.close();
  }
});

test("checkout fails clearly when Forgejo has no such sha", async () => {
  const f = await fakeForgejo({});
  try {
    await assert.rejects(checkout(f.cfg, "0123456789ab"), /HTTP 404/);
  } finally {
    await f.close();
  }
});

test("runChecks: an invalid path or selection is reported, not thrown; a missing binary degrades gracefully", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-review-dir-"));
  try {
    const invalid = await runChecks(dir, { sha: "x", kustomizations: ["../escape"], pytest_select: "rm -rf /" });
    assert.match(invalid, /invalid path/);
    assert.match(invalid, /invalid selection expression/);

    const prevKubectl = process.env.KUBECTL_BIN;
    process.env.KUBECTL_BIN = "definitely-not-a-real-binary-xyz";
    const missing = await runChecks(dir, { sha: "x", kustomizations: ["apps/ai/jev"] });
    assert.match(missing, /not run: definitely-not-a-real-binary-xyz is not installed/);
    process.env.KUBECTL_BIN = prevKubectl;

    assert.equal(await runChecks(dir, { sha: "x" }), "Nothing to check: give kustomizations and/or pytest_select.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runChecks caps the number of kustomizations at 8", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pr-review-dir-"));
  try {
    process.env.KUBECTL_BIN = "definitely-not-a-real-binary-xyz";
    const many = Array.from({ length: 12 }, (_, i) => `apps/x${i}`);
    const out = await runChecks(dir, { sha: "x", kustomizations: many });
    assert.equal(out.split("not run:").length - 1, 8);
  } finally {
    delete process.env.KUBECTL_BIN;
    await rm(dir, { recursive: true, force: true });
  }
});

test("postOrUpdateComment posts once, then edits the same comment on a later call", async () => {
  const f = await fakeForgejo({});
  try {
    const first = await postOrUpdateComment(f.cfg, 42, "first review");
    assert.equal(first.created, true);
    assert.equal(f.state.comments[0].body, "first review");

    const second = await postOrUpdateComment(f.cfg, 42, "updated after a push", first.id);
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);
    assert.equal(f.state.comments.length, 1, "no second comment was created");
    assert.equal(f.state.comments[0].body, "updated after a push");

    const posts = f.state.calls.filter((c) => c.method === "POST" && /\/comments$/.test(c.path));
    const patches = f.state.calls.filter((c) => c.method === "PATCH");
    assert.equal(posts.length, 1);
    assert.equal(patches.length, 1);
  } finally {
    await f.close();
  }
});
