// homelab-pr-review: the tools a Forgejo-PR review session gets, started by Jev's POST /forgejo
// (docs/jev.md "PR review" in homelab-gitops). Read only, no bash: the only two tools are
//   pr_checks    runs this repo's own offline checks (kubectl kustomize, a tests/tdd subset) against
//                a scratch checkout of the PR head, fetched through the Forgejo API as a tarball --
//                never `git clone`, so no git credentials are needed beyond the API token.
//   pr_comment   posts exactly one PR comment, editing it in place on every later call (a new push
//                re-briefs the same session, which calls pr_comment again instead of posting twice).
// Never approve, merge or change labels: those tools don't exist here.
// Env: REVIEW_API, REVIEW_REPO, REVIEW_TOKEN (read:repository + write:issue only -- narrower than
// GITOPS_TOKEN, which also needs write access to push a jev/ branch). Without all three the tools
// are not offered. KUBECTL_BIN (default kubectl), PYTEST_BIN (default pytest), CHECKS_TIMEOUT_MS
// (default 120000), PR_REVIEW_SCRATCH_DIR (default os.tmpdir()/pr-review).
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section, type ToolRegistration } from "@earendil-works/pi-durable";

export const PR_REVIEW_NAME = "homelab-pr-review";

export type ReviewConfig = { api: string; repo: string; token: string };

export function reviewConfig(env = process.env): ReviewConfig | undefined {
  const { REVIEW_API: api, REVIEW_REPO: repo, REVIEW_TOKEN: token } = env;
  if (!api || !repo || !token) return undefined;
  return { api: api.replace(/\/+$/, ""), repo, token };
}

async function call(cfg: ReviewConfig, method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${cfg.api}/repos/${cfg.repo}${path}`, {
    method,
    headers: { Authorization: `token ${cfg.token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw Error(`Forgejo ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return { status: res.status, text };
}

async function fetchArchiveBuffer(cfg: ReviewConfig, sha: string): Promise<Buffer> {
  const res = await fetch(`${cfg.api}/repos/${cfg.repo}/archive/${sha}.tar.gz`, {
    headers: { Authorization: `token ${cfg.token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw Error(`Forgejo archive ${sha}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

const SHA = /^[0-9a-f]{7,40}$/;
const CHECK_PATH = /^[A-Za-z0-9._\-/]{1,200}$/;
const safePath = (p: string) => CHECK_PATH.test(p) && !p.split("/").some((s) => s === ".." || s === "." || s === "");
// pytest -k expression: identifiers, logical keywords, quotes, spaces. Never interpreted by a shell
// (execFile passes it as one argv element), but still worth a tight allow-list.
const PYTEST_SELECT = /^[\w.\-"' ]{1,300}$/;
const MAX_OUTPUT = 20_000;
const TIMEOUT_MS = Number(process.env.CHECKS_TIMEOUT_MS) || 120_000;

function run(bin: string, argv: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(bin, argv, { cwd, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return resolve(`(not run: ${bin} is not installed in this environment)`);
      const out = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
      const text = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n… (${out.length - MAX_OUTPUT} more characters cut)` : out;
      resolve(err && !out ? `exit: ${err.message}` : err ? `${text}\n(exit ${(err as { code?: unknown }).code ?? "error"})` : text || "(no output)");
    });
  });
}

/** Extracts the PR head's tarball into a fresh scratch dir. Exported for tests. */
export async function checkout(cfg: ReviewConfig, sha: string): Promise<string> {
  if (!SHA.test(sha)) throw Error(`Invalid sha: ${JSON.stringify(sha)}`);
  const base = process.env.PR_REVIEW_SCRATCH_DIR || join(tmpdir(), "pr-review");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, `${sha.slice(0, 12)}-`));
  const tar = join(dir, "src.tar.gz");
  await writeFile(tar, await fetchArchiveBuffer(cfg, sha));
  const err = await run("tar", ["xzf", tar, "--strip-components=1", "-C", dir], dir);
  if (err.startsWith("exit:") || /\(exit /.test(err)) throw Error(`could not extract the PR head archive: ${err}`);
  return dir;
}

export type PrChecksArgs = { sha: string; kustomizations?: string[]; pytest_select?: string };

/** Runs the requested offline checks in `dir`, one report per check. Exported for tests. */
export async function runChecks(dir: string, a: PrChecksArgs): Promise<string> {
  const parts: string[] = [];
  for (const raw of (a.kustomizations ?? []).slice(0, 8)) {
    if (!safePath(raw)) {
      parts.push(`kubectl kustomize ${raw}: invalid path`);
      continue;
    }
    const out = await run(process.env.KUBECTL_BIN ?? "kubectl", ["kustomize", raw], dir);
    parts.push(`$ kubectl kustomize ${raw}\n${out}`);
  }
  if (a.pytest_select) {
    if (!PYTEST_SELECT.test(a.pytest_select)) parts.push(`pytest -k ${JSON.stringify(a.pytest_select)}: invalid selection expression`);
    else {
      const out = await run(process.env.PYTEST_BIN ?? "pytest", ["-k", a.pytest_select, "tests/tdd"], dir);
      parts.push(`$ pytest -k ${JSON.stringify(a.pytest_select)} tests/tdd\n${out}`);
    }
  }
  return parts.length ? parts.join("\n\n") : "Nothing to check: give kustomizations and/or pytest_select.";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const MAX_COMMENT = 60_000;

/** PATCHes `priorCommentId` when given, else POSTs a new comment. Exported for tests;
 * the tool itself only adds the durable-doc lookup/store of `priorCommentId`/the result. */
export async function postOrUpdateComment(
  cfg: ReviewConfig, number: number, body: string, priorCommentId?: number,
): Promise<{ id: number; created: boolean }> {
  if (priorCommentId) {
    await call(cfg, "PATCH", `/issues/comments/${priorCommentId}`, { body });
    return { id: priorCommentId, created: false };
  }
  const created = JSON.parse((await call(cfg, "POST", `/issues/${number}/comments`, { body })).text) as { id: number };
  return { id: created.id, created: true };
}

/** The one comment this session has posted on a PR, so a later push edits it instead of posting again. */
const Commented = defineDoc<{ commentId?: number }>({
  kind: "pr-review.commented",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

export const PR_REVIEW_PROMPT = `You are reviewing a Forgejo pull request on homelab-gitops. Work read-only: no bash, no approve, no merge, no label changes.
- Call pr_checks once with the sha from the brief, the kustomization paths this PR touches (under apps/ or clusters/k3s2/), and a pytest -k expression that selects the tests/tdd files most relevant to those paths. Treat a "(not run: ... is not installed)" result as inconclusive, not a pass.
- Then call pr_comment exactly once with a comment covering: a one-paragraph summary, pass/fail for each CLAUDE.md invariant that applies (no wait: true on a leaf Kustomization, critical-stateful placement, no harbor.lab.apj.dev image prefix, a Homepage tile has a service-control/catalog.yaml entry, an LXC move has a DISPOSITION.yaml entry, the repo's PR template sections are filled in), risks, and open questions.
- pr_comment edits its own previous comment on this PR automatically; never call it more than once per brief.`;

export function createPrReview(review: ReviewConfig | undefined = reviewConfig()) {
  const tools: ToolRegistration[] = [];
  if (review) {
    const prChecks = defineTool({
      name: "pr_checks",
      description:
        "Run this repo's own offline checks (kubectl kustomize on paths this PR touches, and a tests/tdd subset via pytest -k) against a scratch checkout of the PR head fetched through the Forgejo API. Read only; never dispatches a build or deploy.",
      parameters: Type.Object({
        sha: Type.String({ description: "the PR's head sha, from the brief" }),
        kustomizations: Type.Optional(
          Type.Array(Type.String({ description: "repo path to kustomize build, e.g. apps/ai/jev" }), { maxItems: 8 }),
        ),
        pytest_select: Type.Optional(Type.String({ description: "pytest -k expression selecting tests/tdd files for the changed paths" })),
      }),
      replay: "safe",
      execute: async (args) => {
        const dir = await checkout(review, args.sha);
        return { content: [{ type: "text", text: await runChecks(dir, args as PrChecksArgs) }] };
      },
    });

    // No replay policy: the default `unsafe` means a crash mid-call returns an interrupted result and
    // never double-posts; Commented tracks the one comment id so a later call edits instead of posting.
    const prComment = defineTool({
      name: "pr_comment",
      description:
        "Post this session's one review comment on the PR, or update it if this session already posted one. Never approves, merges or changes labels.",
      parameters: Type.Object({
        number: Type.Integer({ minimum: 1, description: "the PR number from the brief" }),
        body: Type.String({ description: "markdown: summary, invariant checks, risks, questions" }),
      }),
      execute: async (args, api, ctx) => {
        const priorId = (await api.commit(async (tx) => ({ ...(await tx.doc(Commented, api.conversationId)) }), ctx)).commentId;
        const { id, created } = await postOrUpdateComment(review, args.number, clip(args.body, MAX_COMMENT), priorId);
        if (created) await api.commit(async (tx) => { (await tx.doc(Commented, api.conversationId)).commentId = id; }, ctx);
        return { content: [{ type: "text", text: `${created ? "Posted" : "Updated"} comment ${id} on PR #${args.number}.` }] };
      },
    });
    tools.push(prChecks as ToolRegistration, prComment as ToolRegistration);
  }

  return defineExtension({
    name: PR_REVIEW_NAME,
    tools,
    sections: [section(PR_REVIEW_NAME, async () => PR_REVIEW_PROMPT, { tag: false })],
  });
}
