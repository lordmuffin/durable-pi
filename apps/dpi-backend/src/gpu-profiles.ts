// gpu-profiles: how an agent requests switching a workload-swap GPU node's active profile, as a pull request on
// Forgejo (git.apj.dev) -- never by running scripts/gpu_profiles/swap.py, kubectl, or the gaming-on/off scripts
// itself. Those stay with the node's deploy workflow (docs/gpu-node-profiles.md): a push that changes
// `active_profile` in the node's workloads.yaml makes the workflow converge the node.
//   - files: exactly the two workload-swap catalogs; the Spark's model profiles (bare-metal/dgx-spark/models.yaml)
//     are a different kind and out of scope for this tool
//   - edit: only the single top-level `active_profile:` line, never a workload, a manifest or the gpu/policy block
//   - validation: the requested profile must be declared in the catalog and fit its GPU-count and VRAM budget,
//     computed from the catalog itself so the PR body's arithmetic cannot be fabricated by the model
//   - dedupe: an open PR already requesting a profile change for the same node gets a comment instead of a second PR
//   - cap: no new PR while GITOPS_PROFILE_MAX_OPEN (reuses GitopsConfig.maxOpen) `jev/gpu-` PRs are open, counted
//     separately from propose_fix's `jev/inc-` PRs
import { parse as parseYaml } from "yaml";
import { callForgejo, checkContent, getFile, type GitopsConfig } from "./gitops.js";

/** The only two catalogs this tool may touch. Keep in sync with tests/tdd/test_pi_durable.py on the homelab repo. */
export const NODE_FILES: Record<string, string> = {
  "andrew-gamingpc": "bare-metal/andrew-gamingpc/workloads.yaml",
  "lxc-k3s2-gpu-a": "bare-metal/lxc-k3s2-gpu-a/workloads.yaml",
};

const ACTIVE_PROFILE_RE = /^active_profile:\s*\S+\s*$/m;
export const PROFILE_BRANCH_PREFIX = "jev/gpu-";

type Workload = { gpus?: number; vram_gib?: number };
type Catalog = {
  node?: string;
  gpu?: { resource?: string; count?: number; vram_gib?: number; reserve_gib?: number };
  active_profile?: string;
  workloads?: Record<string, Workload>;
  profiles?: Record<string, string[] | null>;
};

export type Budget = {
  resource: string;
  count: number;
  vram: number;
  reserve: number;
  gpus: number;
  vramSum: number;
  members: string[];
  current: string;
};

function parseCatalog(node: string, text: string): Catalog {
  let doc: Catalog;
  try {
    doc = (parseYaml(text) ?? {}) as Catalog;
  } catch (e) {
    throw Error(`${node}: workloads.yaml does not parse as YAML (${(e as Error).message})`);
  }
  if (doc.node !== node) throw Error(`${node}: workloads.yaml declares node ${JSON.stringify(doc.node)}`);
  return doc;
}

/**
 * Parses the catalog's YAML and computes `profile`'s members, GPU count and VRAM sum against the node's budget,
 * without regard to whether it is already the active profile. Used both to validate a proposed change and, after
 * one has merged, to check what the now-active profile actually needs (gpu-verify.ts). Throws a message the model
 * can act on; never writes anything. Exported for tests.
 */
export function profileBudget(node: string, text: string, profile: string): Budget {
  const doc = parseCatalog(node, text);
  const profiles = doc.profiles ?? {};
  const names = Object.keys(profiles);
  if (!Object.hasOwn(profiles, profile)) throw Error(`${node}: unknown profile ${JSON.stringify(profile)} (known: ${names.sort().join(", ") || "none"})`);
  const current = String(doc.active_profile ?? "");

  const gpu = doc.gpu ?? {};
  const { resource, count, vram_gib: vram, reserve_gib: reserve = 0 } = gpu;
  if (!resource || typeof count !== "number" || typeof vram !== "number")
    throw Error(`${node}: workloads.yaml is missing gpu.resource, gpu.count or gpu.vram_gib`);

  const workloads = doc.workloads ?? {};
  const members = [...new Set(profiles[profile] ?? [])];
  const unknown = members.filter((m) => !Object.hasOwn(workloads, m));
  if (unknown.length) throw Error(`${node}: profile ${profile} references unknown workload(s) ${unknown.join(", ")}`);

  const gpus = members.reduce((n, m) => n + Number(workloads[m]?.gpus ?? 0), 0);
  const vramSum = members.reduce((n, m) => n + Number(workloads[m]?.vram_gib ?? 0), 0);
  const budget = vram - reserve;
  if (gpus > count) throw Error(`${node}: profile ${profile} needs ${gpus} ${resource} but the node budget is ${count}`);
  if (vramSum > budget)
    throw Error(`${node}: profile ${profile} needs ${vramSum.toFixed(1)} GiB VRAM but only ${budget.toFixed(1)} GiB (${vram} - reserve ${reserve}) is budgeted`);

  return { resource, count, vram, reserve, gpus, vramSum, members, current };
}

/** profileBudget, plus the guard that a proposed change is pointless when the profile is already active. Exported for tests. */
export function checkProfile(node: string, text: string, profile: string): Budget {
  const b = profileBudget(node, text, profile);
  if (profile === b.current) throw Error(`${node}: active_profile is already ${JSON.stringify(profile)}`);
  return b;
}

/** Rewrites the catalog's one `active_profile:` line. Throws unless it occurs exactly once. Exported for tests. */
export function setActiveProfile(text: string, profile: string) {
  const matches = text.match(new RegExp(ACTIVE_PROFILE_RE.source, "gm")) ?? [];
  if (matches.length !== 1) throw Error(`expected exactly one top-level 'active_profile:' line, found ${matches.length}`);
  return text.replace(ACTIVE_PROFILE_RE, `active_profile: ${profile}`);
}

export type ProfileArgs = { node: string; profile: string; reason: string };
export type ProfileResult = { kind: "opened" | "commented"; number: number; url: string; branch?: string };
type Pull = { number: number; html_url: string; head: { ref: string } };

/** Validates the request, then opens one PR (or comments on the open one for the same node). */
export async function proposeProfileChange(cfg: GitopsConfig, a: ProfileArgs, meta: { session: string }): Promise<ProfileResult> {
  const node = a.node;
  const path = NODE_FILES[node];
  if (!path) throw Error(`node must be one of: ${Object.keys(NODE_FILES).sort().join(", ")}`);
  const profile = a.profile?.trim();
  if (!profile) throw Error("profile is required");
  const reason = a.reason?.trim();
  if (!reason) throw Error("reason is required");

  const cur = await getFile(cfg, path);
  if (!cur) throw Error(`${path} does not exist on ${cfg.base}`);
  const budget = checkProfile(node, cur.text, profile);
  const newText = setActiveProfile(cur.text, profile);
  checkContent(path, newText);

  const title = `${node}: switch GPU profile ${budget.current} -> ${profile}`.slice(0, 100);
  const arithmetic = [
    `- Budget: ${budget.count} x ${budget.resource}, ${(budget.vram - budget.reserve).toFixed(1)} GiB VRAM (${budget.vram} - reserve ${budget.reserve})`,
    `- \`${profile}\`: ${budget.members.length ? budget.members.join(", ") : "(empty)"} = ${budget.gpus} ${budget.resource}, ${budget.vramSum.toFixed(1)} GiB VRAM`,
  ].join("\n");
  const body = [
    `**Node:** \`${node}\` (\`${path}\`)`,
    `**Profile:** \`${budget.current}\` -> \`${profile}\``,
    "",
    reason.slice(0, 2000),
    "",
    "### VRAM arithmetic",
    arithmetic,
    "",
    `---\nProposed by a pi-durable agent (session \`${meta.session.slice(0, 8)}\`). ` +
      `CI runs scripts/ci/validate-gpu-workloads.py on this PR. On merge, the deploy workflow converges ${node} to ${profile}; this agent never runs swap.py, kubectl apply, or gaming-on/off itself.`,
  ].join("\n");

  const open = await callForgejo<Pull[]>(cfg, "GET", "/pulls?state=open&limit=50");
  const ours = open.filter((p) => p.head?.ref?.startsWith(PROFILE_BRANCH_PREFIX));
  const prefixForNode = `${PROFILE_BRANCH_PREFIX}${node}-`;
  const same = ours.find((p) => p.head.ref.startsWith(prefixForNode));
  if (same) {
    await callForgejo(cfg, "POST", `/issues/${same.number}/comments`, {
      body: `Requested again: \`${budget.current}\` -> \`${profile}\`.\n\n${body}`,
    });
    return { kind: "commented", number: same.number, url: same.html_url };
  }
  if (ours.length >= cfg.maxOpen)
    throw Error(`${ours.length} GPU profile PRs are already open (limit ${cfg.maxOpen}). Wait for one to merge or close first.`);

  const branch = `${prefixForNode}${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}`;
  await callForgejo(cfg, "POST", "/contents", {
    branch: cfg.base,
    new_branch: branch,
    message: `chore(${node}): switch GPU profile to ${profile}`,
    files: [{ operation: "update", path, content: Buffer.from(newText, "utf8").toString("base64"), sha: cur.sha }],
  });
  const pr = await callForgejo<Pull>(cfg, "POST", "/pulls", { base: cfg.base, head: branch, title, body });
  await callForgejo(cfg, "POST", `/issues/${pr.number}/labels`, { labels: ["jev-proposed"] }).catch(() => undefined);
  return { kind: "opened", number: pr.number, url: pr.html_url, branch };
}
