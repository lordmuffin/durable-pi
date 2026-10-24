// homelab-incident: the tools an incident session gets on top of upstream's read-only tools.
//   k8s_read  kubectl get/describe/logs and flux get, built as argv (no shell) from allow-listed parts. It runs as
//             the pod's ServiceAccount, which holds the `view` ClusterRole plus read on Flux CRDs, so it cannot write
//             or read Secrets whatever the arguments.
//   save_rca  writes one incident's RCA under App State /incidents/<id>; no other path is writable.
//   notify    posts one message to the ntfy topic (NTFY_URL), at most a few times per agent.
//   gitops_read, propose_fix   read homelab-gitops and open a fix PR on Forgejo (gitops.ts); offered only when
//             GITOPS_API, GITOPS_REPO and GITOPS_TOKEN are set. Not write tools for Read only: they never touch the
//             cluster or this pod, only a jev/ branch a person must merge.
// Env: KUBECTL_BIN, FLUX_BIN (default kubectl, flux on PATH), NTFY_URL (e.g. http://ntfy.ntfy.svc.cluster.local/infra_alerts).
import { execFile } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section, type ToolRegistration } from "@earendil-works/pi-durable";
import type { SharedState } from "./shared-state.js";
import { gitopsConfig, gitopsRead, proposeFix, type FixArgs } from "./gitops.js";
import { renderFacts } from "./facts.js";

export const INCIDENT_NAME = "homelab-incident";

const NAME = /^[a-z0-9]([a-z0-9.\-]{0,251}[a-z0-9])?$/;
const SELECTOR = /^[a-zA-Z0-9.\-_/=,!() ]{1,200}$/;
const KUBECTL_VERBS = ["get", "describe", "logs"] as const;
// Plain resource names; `view` already excludes Secrets, and the list keeps the tool's intent obvious.
const KUBECTL_RESOURCES = new Set([
  "pods", "pod", "po", "deployments", "deployment", "deploy", "statefulsets", "statefulset", "sts", "daemonsets",
  "daemonset", "ds", "replicasets", "rs", "jobs", "job", "cronjobs", "cronjob", "services", "service", "svc",
  "endpoints", "ep", "ingresses", "ingress", "ing", "configmaps", "configmap", "cm", "persistentvolumeclaims", "pvc",
  "events", "ev", "namespaces", "ns", "nodes", "node", "no", "persistentvolumes", "pv", "storageclasses", "sc",
  "kustomizations.kustomize.toolkit.fluxcd.io", "helmreleases.helm.toolkit.fluxcd.io",
  "gitrepositories.source.toolkit.fluxcd.io", "helmrepositories.source.toolkit.fluxcd.io",
  "ocirepositories.source.toolkit.fluxcd.io", "helmcharts.source.toolkit.fluxcd.io",
]);
const FLUX_KINDS: Record<string, string[]> = {
  all: ["all"],
  kustomizations: ["kustomizations"],
  helmreleases: ["helmreleases"],
  "sources git": ["sources", "git"],
  "sources helm": ["sources", "helm"],
  "sources oci": ["sources", "oci"],
  "sources chart": ["sources", "chart"],
  "sources all": ["sources", "all"],
};
const OUTPUTS = new Set(["wide", "yaml", "json", "name"]);
const MAX_OUTPUT = 20_000;

export type K8sReadArgs = {
  tool: "kubectl" | "flux";
  verb?: string;
  resource: string;
  name?: string;
  namespace?: string;
  all_namespaces?: boolean;
  selector?: string;
  container?: string;
  tail?: number;
  previous?: boolean;
  output?: string;
};

const check = (value: string | undefined, pattern: RegExp, what: string) => {
  if (value !== undefined && !pattern.test(value)) throw Error(`Invalid ${what}: ${JSON.stringify(value)}`);
  return value;
};

/** The exact argv k8s_read runs, or a thrown message the model can act on. Exported for tests. */
export function k8sArgv(a: K8sReadArgs): { bin: string; argv: string[] } {
  const ns = check(a.namespace, NAME, "namespace");
  const name = check(a.name, NAME, "name");
  const scope = a.all_namespaces ? ["--all-namespaces"] : ns ? ["-n", ns] : [];
  if (a.tool === "flux") {
    const kind = FLUX_KINDS[a.resource];
    if (!kind) throw Error(`flux get supports: ${Object.keys(FLUX_KINDS).join(", ")}`);
    return { bin: process.env.FLUX_BIN ?? "flux", argv: ["get", ...kind, ...(name ? [name] : []), ...scope] };
  }
  if (a.tool !== "kubectl") throw Error("tool must be kubectl or flux");
  const verb = a.verb ?? "get";
  if (!(KUBECTL_VERBS as readonly string[]).includes(verb)) throw Error(`kubectl verbs: ${KUBECTL_VERBS.join(", ")}`);
  const bin = process.env.KUBECTL_BIN ?? "kubectl";
  if (verb === "logs") {
    if (!name) throw Error("kubectl logs needs a pod name");
    const container = check(a.container, NAME, "container");
    const tail = Math.min(Math.max(Math.trunc(a.tail ?? 200), 1), 2000);
    return {
      bin,
      argv: ["logs", name, ...scope, ...(container ? ["-c", container] : []), `--tail=${tail}`, ...(a.previous ? ["--previous"] : [])],
    };
  }
  if (!KUBECTL_RESOURCES.has(a.resource)) throw Error(`Unsupported resource ${a.resource}`);
  const selector = check(a.selector, SELECTOR, "selector");
  if (a.output !== undefined && (verb !== "get" || !OUTPUTS.has(a.output)))
    throw Error(`output applies to get only, one of: ${[...OUTPUTS].join(", ")}`);
  return {
    bin,
    argv: [verb, a.resource, ...(name ? [name] : []), ...scope, ...(selector ? ["-l", selector] : []), ...(a.output ? ["-o", a.output] : [])],
  };
}

function run(bin: string, argv: string[], signal?: AbortSignal) {
  return new Promise<string>((resolve) => {
    execFile(bin, argv, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, signal, env: process.env }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
      const text = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n… (${out.length - MAX_OUTPUT} more characters cut)` : out;
      resolve(err && !out ? `exit: ${err.message}` : err ? `${text}\n(exit ${(err as { code?: unknown }).code ?? "error"})` : text || "(no output)");
    });
  });
}

/** notify works this many times per agent, so a looping model cannot flood the topic. */
const NOTIFY_LIMIT = 3;
const Notified = defineDoc<{ count: number }>({
  kind: "incident.notified",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ count: 0 }),
});

const MAX_INCIDENTS = 20;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const INCIDENT_PROMPT = `You are investigating a homelab incident on the k3s2 cluster. Work read-only.
- Use k8s_read for cluster facts: flux get (kustomizations, helmreleases, sources) first for Flux failures, then kubectl get/describe/logs on what they point at. k3s2 pod logs are not in Loki; kubectl logs is the only log source.
- When you know the cause, call save_rca once, then notify once with a two-line summary. Do not guess: say what you could not confirm.`;

export const FIX_PROMPT = `The cluster is deployed by Flux from the homelab-gitops repo; you can read it with gitops_read and propose one fix with propose_fix after save_rca.
- Propose a fix only when the root cause is confirmed and a manifest change under apps/ or clusters/k3s2/ resolves it: a wrong image tag, ref, name, path, resource limit or missing manifest. gitops_read every file before you edit it and keep the change minimal.
- Never put secret values in git. When a credential is missing, propose the OnePasswordItem or ExternalSecret manifest if that is what is missing, and say in person_must which 1Password item a person has to create.
- Skip propose_fix when the fix is outside git (hardware, storage, a registry, a value only a person has) or you are unsure; the RCA remediation covers it. propose_fix notifies on its own, so your notify call should just mention the PR.`;

/** propose_fix works this many times per agent; a rejected change (bad path, no match) uses one too. */
const FIX_LIMIT = 3;
const Proposed = defineDoc<{ count: number }>({
  kind: "incident.proposed",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ count: 0 }),
});

async function postNtfy(headers: Record<string, string>, body: string) {
  const url = process.env.NTFY_URL;
  if (!url) throw Error("NTFY_URL is not set on this device");
  const res = await fetch(url, { method: "POST", headers, body: clip(body, 1500), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw Error(`ntfy HTTP ${res.status}`);
}

export function createIncident(shared: SharedState, sessionId: string, gitops = gitopsConfig()) {
  const k8sRead = defineTool({
    name: "k8s_read",
    description:
      "Read the k3s2 cluster as a view-only ServiceAccount. tool=kubectl: verb get|describe|logs on an allow-listed resource (logs takes a pod name). tool=flux: flux get <resource> where resource is all, kustomizations, helmreleases, or 'sources git|helm|oci|chart|all'. No writes, no Secrets.",
    parameters: Type.Object({
      tool: Type.Union([Type.Literal("kubectl"), Type.Literal("flux")]),
      verb: Type.Optional(Type.Union(KUBECTL_VERBS.map((v) => Type.Literal(v)))),
      resource: Type.String({ description: "kubectl resource (pods, deployments, events, ...) or flux kind" }),
      name: Type.Optional(Type.String()),
      namespace: Type.Optional(Type.String()),
      all_namespaces: Type.Optional(Type.Boolean()),
      selector: Type.Optional(Type.String({ description: "label selector for kubectl get/describe" })),
      container: Type.Optional(Type.String()),
      tail: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })),
      previous: Type.Optional(Type.Boolean()),
      output: Type.Optional(Type.String({ description: "kubectl get only: wide, yaml, json or name" })),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const { bin, argv } = k8sArgv(args as K8sReadArgs);
      api.output(`$ ${bin} ${argv.join(" ")}\n`);
      return { content: [{ type: "text", text: await run(bin, argv) }] };
    },
  });

  const saveRca = defineTool({
    name: "save_rca",
    description:
      "Save this incident's root-cause analysis to App State at /incidents/<incident_id>. Overwrites an earlier RCA for the same id. The only state this session may write.",
    parameters: Type.Object({
      incident_id: Type.String({ description: "lowercase id from the incident brief, e.g. inc-1a2b3c4d" }),
      severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]),
      summary: Type.String({ description: "one sentence" }),
      root_cause: Type.String(),
      evidence: Type.Array(Type.String(), { maxItems: 10 }),
      remediation: Type.String({ description: "what a person should do; you do not do it" }),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const id = check(args.incident_id, NAME, "incident_id")!;
      const rca = {
        severity: args.severity,
        summary: clip(args.summary, 300),
        root_cause: clip(args.root_cause, 2000),
        evidence: args.evidence.slice(0, 10).map((e) => clip(e, 400)),
        remediation: clip(args.remediation, 1000),
        session: sessionId,
        savedAt: new Date().toISOString(),
      };
      const receipt = `rca:${sessionId}:${api.taskId}`;
      const state = (await shared.snapshot()).value as { incidents?: Record<string, { savedAt?: string }> };
      if (!state.incidents || typeof state.incidents !== "object")
        await shared.change({ operation: "create", path: "/incidents", value: {} }, `${receipt}:root`);
      const incidents = ((await shared.snapshot()).value as { incidents: Record<string, { savedAt?: string }> }).incidents;
      // Keep App State under its size cap: drop the oldest RCAs beyond MAX_INCIDENTS.
      const old = Object.entries(incidents)
        .filter(([k]) => k !== id)
        .sort(([, a], [, b]) => String(a?.savedAt).localeCompare(String(b?.savedAt)));
      for (const [k] of old.slice(0, Math.max(0, old.length - (MAX_INCIDENTS - 1))))
        await shared.change({ operation: "delete", path: `/incidents/${k}` }, `${receipt}:prune:${k}`);
      await shared.change({ operation: id in incidents ? "update" : "create", path: `/incidents/${id}`, value: rca }, receipt);
      return { content: [{ type: "text", text: `Saved the RCA to App State /incidents/${id}.` }] };
    },
  });

  // No replay policy: the default `unsafe` means a crash mid-call returns an interrupted result and never posts twice.
  const notify = defineTool({
    name: "notify",
    description: `Post a short message to the homelab ntfy alert topic. Works ${NOTIFY_LIMIT} times per agent; use it once, after save_rca.`,
    parameters: Type.Object({
      title: Type.String({ description: "under 80 characters" }),
      message: Type.String({ description: "two or three lines" }),
      priority: Type.Optional(Type.Union([Type.Literal("default"), Type.Literal("high"), Type.Literal("urgent")])),
    }),
    execute: async (args, api, ctx) => {
      if (!process.env.NTFY_URL) throw Error("NTFY_URL is not set on this device");
      await api.commit(async (tx) => {
        const doc = await tx.doc(Notified, api.conversationId);
        if (doc.count >= NOTIFY_LIMIT) throw Error(`notify already used ${NOTIFY_LIMIT} times by this agent`);
        doc.count++;
      }, ctx);
      await postNtfy({ Title: clip(args.title, 80), Priority: args.priority ?? "default", Tags: "robot,mag" }, args.message);
      return { content: [{ type: "text", text: "Posted to ntfy." }] };
    },
  });

  const tools = [k8sRead, saveRca, notify] as ToolRegistration[];
  if (gitops) {
    const gitopsReadTool = defineTool({
      name: "gitops_read",
      description: `Read the homelab-gitops repo (what Flux deploys) on ${gitops.base}: a file's text, or a directory listing. path "" lists the root.`,
      parameters: Type.Object({ path: Type.String({ description: "repo path, e.g. apps/ai/jev or clusters/k3s2/ai/jev.yaml" }) }),
      replay: "safe",
      execute: async (args) => ({ content: [{ type: "text", text: await gitopsRead(gitops, args.path) }] }),
    });

    // No replay policy: a crash mid-call returns an interrupted result and never opens a second PR.
    const proposeFixTool = defineTool({
      name: "propose_fix",
      description: `Open a pull request on homelab-gitops with a fix for this incident, then send a notification linking it. Writes only a new jev/<incident_id> branch; a person reviews and merges. Only apps/ and clusters/k3s2/ YAML/JSON/MD, never flux-system, apps/secrets or SOPS files, never secret values. If a PR for the same alert is open, comments on it instead. Works ${FIX_LIMIT} times per agent.`,
      parameters: Type.Object({
        incident_id: Type.String({ description: "the id from the brief, e.g. inc-1a2b3c4d-20261023t1206" }),
        title: Type.String({ description: "PR title, under 80 characters, imperative" }),
        rationale: Type.String({ description: "root cause and why this change fixes it, with the evidence" }),
        edits: Type.Optional(
          Type.Array(
            Type.Object({
              path: Type.String(),
              old_string: Type.String({ description: "exact text from gitops_read, unique in the file" }),
              new_string: Type.String(),
            }),
            { maxItems: 8 },
          ),
        ),
        creates: Type.Optional(Type.Array(Type.Object({ path: Type.String(), content: Type.String() }), { maxItems: 4 })),
        person_must: Type.Optional(Type.String({ description: "steps outside git a person must do first, e.g. create a 1Password item" })),
      }),
      execute: async (args, api, ctx) => {
        await api.commit(async (tx) => {
          const doc = await tx.doc(Proposed, api.conversationId);
          if (doc.count >= FIX_LIMIT) throw Error(`propose_fix already used ${FIX_LIMIT} times by this agent`);
          doc.count++;
        }, ctx);
        const r = await proposeFix(gitops, args as FixArgs, { session: sessionId });
        api.output(`${r.kind} PR #${r.number}: ${r.url}\n`);
        let note = "";
        if (r.kind === "opened")
          try {
            await postNtfy(
              { Title: clip(`PR #${r.number}: ${args.title}`, 80), Priority: "default", Tags: "robot,wrench", Click: r.url },
              `${args.incident_id}\n${clip(args.rationale, 600)}${args.person_must ? `\n\nFirst: ${args.person_must}` : ""}`,
            );
          } catch (e) {
            note = ` The PR notification failed (${e instanceof Error ? e.message : e}); mention the PR in your notify call.`;
          }
        const what = r.kind === "opened" ? `Opened PR #${r.number} from ${r.branch}` : `PR #${r.number} for this alert was already open; added the fix as a comment`;
        return { content: [{ type: "text", text: `${what}: ${r.url}.${note}` }] };
      },
    });
    tools.push(gitopsReadTool as ToolRegistration, proposeFixTool as ToolRegistration);
  }

  return defineExtension({
    name: INCIDENT_NAME,
    tools,
    sections: [
      // Facts first: the agent should know the homelab's current state before the incident prompt below.
      section("homelab-facts", async () => renderFacts((await shared.snapshot()).value), { tag: false }),
      section(INCIDENT_NAME, async () => (gitops ? `${INCIDENT_PROMPT}\n\n${FIX_PROMPT}` : INCIDENT_PROMPT), { tag: false }),
    ],
  });
}
