// homelab-incident: the three tools an incident session gets on top of upstream's read-only tools.
//   k8s_read  kubectl get/describe/logs and flux get, built as argv (no shell) from allow-listed parts. It runs as
//             the pod's ServiceAccount, which holds the `view` ClusterRole plus read on Flux CRDs, so it cannot write
//             or read Secrets whatever the arguments.
//   save_rca  writes one incident's RCA under App State /incidents/<id>; no other path is writable.
//   notify    posts one message to the ntfy topic (NTFY_URL), at most a few times per agent.
// Env: KUBECTL_BIN, FLUX_BIN (default kubectl, flux on PATH), NTFY_URL (e.g. http://ntfy.ntfy.svc.cluster.local/infra_alerts).
import { execFile } from "node:child_process";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import type { SharedState } from "./shared-state.js";

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

export function createIncident(shared: SharedState, sessionId: string) {
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
      const url = process.env.NTFY_URL;
      if (!url) throw Error("NTFY_URL is not set on this device");
      await api.commit(async (tx) => {
        const doc = await tx.doc(Notified, api.conversationId);
        if (doc.count >= NOTIFY_LIMIT) throw Error(`notify already used ${NOTIFY_LIMIT} times by this agent`);
        doc.count++;
      }, ctx);
      const res = await fetch(url, {
        method: "POST",
        headers: { Title: clip(args.title, 80), Priority: args.priority ?? "default", Tags: "robot,mag" },
        body: clip(args.message, 1500),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw Error(`ntfy HTTP ${res.status}`);
      return { content: [{ type: "text", text: "Posted to ntfy." }] };
    },
  });

  return defineExtension({
    name: INCIDENT_NAME,
    tools: [k8sRead, saveRca, notify],
    sections: [section(INCIDENT_NAME, async () => INCIDENT_PROMPT, { tag: false })],
  });
}
