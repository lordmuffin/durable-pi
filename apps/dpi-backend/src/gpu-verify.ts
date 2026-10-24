// gpu-verify: the HTTP calls the profile-verify durable job (jobs.ts) makes to confirm a merged profile-change PR
// actually converged the node, without ever running swap.py, kubectl, flux or any shell command itself -- every
// call here is a plain fetch(), never execFile/exec, so there is no argv or shell to build in the first place.
//   wait    poll the Forgejo PR and its deploy workflow run (callForgejo, same client gitops.ts uses)
//   check   the node-control/model dashboard's read-only status API, and a one-token LiteLLM request per model
//   bench   a fixed short prompt against each model, timed
// Env: DASHBOARD_API (default https://dgx-spark-dashboard.lab.apj.dev), OPENAI_BASE_URL/OPENAI_API_KEY (the same
// LiteLLM endpoint every agent call already goes through; docs/pi-durable.md).
import { callForgejo, type GitopsConfig } from "./gitops.js";

/** Which deploy workflow applies a merge to each workload-swap node's main branch. */
export const NODE_WORKFLOWS: Record<string, string> = {
  "andrew-gamingpc": "deploy-k3s-andrew-gamingpc.yml",
  "lxc-k3s2-gpu-a": "deploy-k3s-lxc-k3s2-gpu-a.yml",
};

type Pull = { merged: boolean; state: string; merge_commit_sha?: string };
export type PrStatus = { merged: boolean; state: string; mergeCommitSha?: string };

/** The PR's merge state, by number. Exported for tests. */
export async function pollPrMerged(cfg: GitopsConfig, prNumber: number): Promise<PrStatus> {
  const pr = await callForgejo<Pull>(cfg, "GET", `/pulls/${prNumber}`);
  return { merged: pr.merged, state: pr.state, mergeCommitSha: pr.merge_commit_sha };
}

type Run = { head_sha: string; status: string; conclusion: string | null; name?: string; path?: string };
export type RunStatus = { status: string; conclusion: string | null };

/** The most recent run of `node`'s deploy workflow against commit `sha`, or undefined if it hasn't started. Exported for tests. */
export async function findWorkflowRun(cfg: GitopsConfig, node: string, sha: string): Promise<RunStatus | undefined> {
  const workflowFile = NODE_WORKFLOWS[node];
  if (!workflowFile) throw Error(`node must be one of: ${Object.keys(NODE_WORKFLOWS).sort().join(", ")}`);
  const page = await callForgejo<{ workflow_runs?: Run[] }>(cfg, "GET", "/actions/runs?limit=50");
  const run = (page.workflow_runs ?? []).find((r) => r.head_sha === sha && (r.path ?? r.name ?? "").includes(workflowFile));
  return run ? { status: run.status, conclusion: run.conclusion } : undefined;
}

/** The dashboard's read-only status for one node (docs/dgx-spark-dashboard.md's GET /api/nodes/{node}/status). Exported for tests. */
export async function fetchNodeStatus(dashboardBase: string, node: string): Promise<unknown> {
  const res = await fetch(`${dashboardBase.replace(/\/+$/, "")}/api/nodes/${encodeURIComponent(node)}/status`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw Error(`dashboard /api/nodes/${node}/status: HTTP ${res.status}`);
  return res.json();
}

type Entry = { ready?: boolean; status?: string; replicas_ready?: number };

/** True when every workload/role in `members` reports ready in the dashboard's status payload. Exported for tests. */
export function membersReady(status: unknown, members: string[]): { ready: boolean; detail: string } {
  const root = (status ?? {}) as Record<string, unknown>;
  const entries = (root.workloads ?? root.roles ?? root) as Record<string, Entry | undefined>;
  const missing = members.filter((m) => {
    const e = entries[m];
    if (!e || typeof e !== "object") return true;
    return !(e.ready === true || e.status === "Running" || (e.replicas_ready ?? 0) >= 1);
  });
  return { ready: missing.length === 0, detail: missing.length ? `not ready: ${missing.join(", ")}` : `ready: ${members.join(", ") || "(none)"}` };
}

export type ChatResult = { ok: boolean; ms: number; completionTokens?: number; text?: string; error?: string };

/** One chat completion against a LiteLLM-fronted model. Exported for tests. */
export async function chatOnce(base: string, apiKey: string, model: string, prompt: string, maxTokens: number): Promise<ChatResult> {
  const start = Date.now();
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens }),
      signal: AbortSignal.timeout(30_000),
    });
    const ms = Date.now() - start;
    if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { completion_tokens?: number } };
    return { ok: true, ms, completionTokens: json.usage?.completion_tokens, text: json.choices?.[0]?.message?.content };
  } catch (e) {
    return { ok: false, ms: Date.now() - start, error: (e as Error).message };
  }
}

/** Completion tokens per second, or undefined when the call failed or reported no tokens. Exported for tests. */
export function tokensPerSecond(r: ChatResult): number | undefined {
  if (!r.ok || !r.completionTokens || r.ms <= 0) return undefined;
  return Math.round((r.completionTokens / (r.ms / 1000)) * 10) / 10;
}
