// gitops: how an incident agent reads homelab-gitops and proposes a fix as a pull request on Forgejo (git.apj.dev).
// The agent never runs git: the tools call the Forgejo API with a bot token, so the only write it can make is a new
// `jev/<incident>` branch plus a PR against main. A person merges; Flux applies. Branch protection on main is the
// server-side backstop.
//   - paths: only under apps/ and clusters/k3s2/, never flux-system/, apps/secrets/ or *.sops.yaml
//   - content: no `kind: Secret` and no PEM blocks; secret values stay a person's job
//   - dedupe: an open PR for the same alert fingerprint (inc-<fp8>) gets a comment instead of a second PR
//   - cap: no new PR while GITOPS_MAX_OPEN jev/ PRs are open
// Env: GITOPS_API (https://git.apj.dev/api/v1), GITOPS_REPO (lordmuffin/homelab-gitops), GITOPS_TOKEN,
// GITOPS_BASE (default main), GITOPS_MAX_OPEN (default 5). Without the first three the tools are not offered.

export type GitopsConfig = { api: string; repo: string; token: string; base: string; maxOpen: number };

export function gitopsConfig(env = process.env): GitopsConfig | undefined {
  const { GITOPS_API: api, GITOPS_REPO: repo, GITOPS_TOKEN: token } = env;
  if (!api || !repo || !token) return undefined;
  return { api: api.replace(/\/+$/, ""), repo, token, base: env.GITOPS_BASE || "main", maxOpen: Number(env.GITOPS_MAX_OPEN) || 5 };
}

const PATH = /^[A-Za-z0-9._\-/]{1,200}$/;
const WRITE_PREFIXES = ["apps/", "clusters/k3s2/"];
const WRITE_EXT = /\.(ya?ml|json|md)$/;
const WRITE_DENY: { pattern: RegExp; why: string }[] = [
  { pattern: /(^|\/)flux-system\//, why: "flux-system is Flux's own bootstrap" },
  { pattern: /^apps\/secrets\//, why: "apps/secrets holds encrypted secrets" },
  { pattern: /\.sops\.ya?ml$/, why: "SOPS files are encrypted" },
];

/** A repo path the read tool accepts, or a thrown message. */
export function readPath(path: string) {
  const p = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (p !== "" && (!PATH.test(p) || p.split("/").some((s) => s === ".." || s === "." || s === "")))
    throw Error(`Invalid path: ${JSON.stringify(path)}`);
  return p;
}

/** A repo path propose_fix may write, or a thrown message the model can act on. Exported for tests. */
export function writePath(path: string) {
  const p = readPath(path);
  if (!WRITE_PREFIXES.some((pre) => p.startsWith(pre))) throw Error(`${p}: fixes may only touch ${WRITE_PREFIXES.join(" or ")}`);
  if (!WRITE_EXT.test(p)) throw Error(`${p}: fixes may only touch .yaml, .yml, .json or .md files`);
  const denied = WRITE_DENY.find((d) => d.pattern.test(p));
  if (denied) throw Error(`${p}: ${denied.why}; leave it to a person`);
  return p;
}

/** Throws when new content would put secret material in git. */
export function checkContent(path: string, text: string) {
  if (/^\s*kind:\s*Secret\s*$/m.test(text))
    throw Error(`${path}: no kind: Secret in git. Propose a OnePasswordItem or ExternalSecret and name the item a person must create.`);
  if (/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/.test(text)) throw Error(`${path}: no keys or certificates in git`);
  if (text.length > 64_000) throw Error(`${path}: over 64 KB`);
}

/** old_string must occur exactly once, like the edit tool. Exported for tests. */
export function applyEdit(path: string, text: string, oldString: string, newString: string) {
  if (!oldString) throw Error(`${path}: old_string is empty`);
  const at = text.indexOf(oldString);
  if (at < 0) throw Error(`${path}: old_string not found; gitops_read the file and copy the text exactly`);
  if (text.indexOf(oldString, at + 1) >= 0) throw Error(`${path}: old_string occurs more than once; include more context`);
  return text.slice(0, at) + newString + text.slice(at + oldString.length);
}

/** The alert-fingerprint part of an incident id (inc-<fp8>-<ts>), shared by every firing of the same alert. */
export const fingerprintOf = (incidentId: string) => incidentId.match(/^inc-([0-9a-f]{8})/)?.[1];

/** A raw Forgejo API call against this repo. Exported so other proposers (e.g. gpu-profiles.ts) share one client. */
export async function callForgejo<T>(cfg: GitopsConfig, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${cfg.api}/repos/${cfg.repo}${path}`, {
    method,
    headers: { Authorization: `token ${cfg.token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw Error(`Forgejo ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

type Entry = { type: string; path: string; name: string; size?: number; content?: string; sha: string };
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

/** One file's text and blob sha on the base branch, or undefined when it does not exist. Exported for reuse. */
export async function getFile(cfg: GitopsConfig, path: string) {
  try {
    const e = await callForgejo<Entry>(cfg, "GET", `/contents/${enc(path)}?ref=${encodeURIComponent(cfg.base)}`);
    if (Array.isArray(e) || e.type !== "file") throw Error(`${path} is a directory`);
    return { text: Buffer.from(e.content ?? "", "base64").toString("utf8"), sha: e.sha };
  } catch (err) {
    if (err instanceof Error && /HTTP 404/.test(err.message)) return undefined;
    throw err;
  }
}

/** A file's text, or a directory listing, on the base branch. */
export async function gitopsRead(cfg: GitopsConfig, path: string) {
  const p = readPath(path);
  const e = await callForgejo<Entry | Entry[]>(cfg, "GET", `/contents/${p ? enc(p) : ""}?ref=${encodeURIComponent(cfg.base)}`);
  if (Array.isArray(e)) return e.map((x) => `${x.type === "dir" ? "d" : "f"} ${x.path}`).join("\n") || "(empty directory)";
  const text = Buffer.from(e.content ?? "", "base64").toString("utf8");
  return text.length > 20_000 ? `${text.slice(0, 20_000)}\n… (${text.length - 20_000} more characters cut)` : text;
}

export type FixArgs = {
  incident_id: string;
  title: string;
  rationale: string;
  edits?: { path: string; old_string: string; new_string: string }[];
  creates?: { path: string; content: string }[];
  person_must?: string;
};

export type FixResult = { kind: "opened" | "commented"; number: number; url: string; branch?: string };
type Pull = { number: number; html_url: string; head: { ref: string } };

/** Validates every change, then opens one PR (or comments on the open one for the same alert). */
export async function proposeFix(cfg: GitopsConfig, a: FixArgs, meta: { session: string }): Promise<FixResult> {
  const id = a.incident_id.toLowerCase();
  if (!/^inc-[a-z0-9-]{1,80}$/.test(id)) throw Error(`Invalid incident_id: ${JSON.stringify(a.incident_id)}`);
  const edits = a.edits ?? [];
  const creates = a.creates ?? [];
  if (edits.length + creates.length === 0) throw Error("Nothing to change: give edits or creates");
  if (edits.length + creates.length > 8) throw Error("At most 8 changes per fix; keep the PR small");

  // Build every file's final text first, so one bad change rejects the whole fix before anything is pushed.
  const files = new Map<string, { text: string; sha?: string }>();
  for (const e of edits) {
    const p = writePath(e.path);
    const cur = files.get(p) ?? (await getFile(cfg, p));
    if (!cur) throw Error(`${p} does not exist on ${cfg.base}; use creates for new files`);
    files.set(p, { text: applyEdit(p, cur.text, e.old_string, e.new_string), sha: cur.sha });
  }
  for (const c of creates) {
    const p = writePath(c.path);
    if (files.has(p) || (await getFile(cfg, p))) throw Error(`${p} already exists; use edits to change it`);
    files.set(p, { text: c.content.endsWith("\n") ? c.content : `${c.content}\n`, sha: undefined });
  }
  for (const [p, f] of files) checkContent(p, f.text);

  const title = a.title.trim().slice(0, 100);
  const changes = [
    ...edits.map((e) => `- \`${e.path}\`\n\n\`\`\`diff\n${diffLines(e.old_string, e.new_string)}\n\`\`\``),
    ...creates.map((c) => `- new \`${c.path}\``),
  ].join("\n");
  const body = [
    `**Incident:** \`${id}\` (RCA in App State \`/incidents/${id}\`)`,
    "",
    a.rationale.trim().slice(0, 3000),
    ...(a.person_must?.trim() ? ["", `**Before merging, a person must:** ${a.person_must.trim().slice(0, 1000)}`] : []),
    "",
    "### Changes",
    changes.slice(0, 20_000),
    "",
    `---\nProposed by the homelab-incident agent (session \`${meta.session.slice(0, 8)}\`). Check CI and the diff before merging; Flux applies it on merge.`,
  ].join("\n");

  const open = await callForgejo<Pull[]>(cfg, "GET", `/pulls?state=open&limit=50`);
  const ours = open.filter((p) => p.head?.ref?.startsWith("jev/"));
  const fp = fingerprintOf(id);
  const same = fp && ours.find((p) => p.head.ref.startsWith(`jev/inc-${fp}`));
  if (same) {
    await callForgejo(cfg, "POST", `/issues/${same.number}/comments`, { body: `The alert fired again as \`${id}\`. Proposed fix:\n\n**${title}**\n\n${body}` });
    return { kind: "commented", number: same.number, url: same.html_url };
  }
  if (ours.length >= cfg.maxOpen)
    throw Error(`${ours.length} jev/ PRs are already open (limit ${cfg.maxOpen}). Put the fix in the RCA remediation instead.`);

  const branch = `jev/${id}`;
  await callForgejo(cfg, "POST", "/contents", {
    branch: cfg.base,
    new_branch: branch,
    message: `fix(${id}): ${title}`,
    files: [...files].map(([path, f]) => ({
      operation: f.sha ? "update" : "create",
      path,
      content: Buffer.from(f.text, "utf8").toString("base64"),
      ...(f.sha ? { sha: f.sha } : {}),
    })),
  });
  const pr = await callForgejo<Pull>(cfg, "POST", "/pulls", { base: cfg.base, head: branch, title: `fix(${id}): ${title}`, body });
  // Best effort: the label only helps filtering.
  await callForgejo(cfg, "POST", `/issues/${pr.number}/labels`, { labels: ["jev-proposed"] }).catch(() => undefined);
  return { kind: "opened", number: pr.number, url: pr.html_url, branch };
}

function diffLines(before: string, after: string) {
  const lines = [...before.split("\n").map((l) => `-${l}`), ...after.split("\n").map((l) => `+${l}`)].join("\n");
  return lines.length > 4000 ? `${lines.slice(0, 4000)}\n… (cut)` : lines;
}
