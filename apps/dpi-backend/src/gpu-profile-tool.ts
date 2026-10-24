// homelab-gpu-profiles: the one tool (propose_profile_change) that lets an agent on a GPU device ask for a
// workload-swap node's active profile to change, as a pull request a person merges. Separate from propose_fix
// (incident.ts): it never needs an incident, and its only allowed edit is the one active_profile: line in a named
// workloads.yaml (gpu-profiles.ts), never a manifest, a workload or the gpu/policy block.
// Offered only when GITOPS_API, GITOPS_REPO and GITOPS_TOKEN are set (gitopsConfig), same as propose_fix.
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, section, type ToolRegistration } from "@earendil-works/pi-durable";
import { gitopsConfig } from "./gitops.js";
import { NODE_FILES, proposeProfileChange, type ProfileArgs } from "./gpu-profiles.js";

export const GPU_PROFILE_NAME = "homelab-gpu-profiles";

/** propose_profile_change works this many times per agent; a rejected request (bad node, no match) uses one too. */
const PROFILE_LIMIT = 3;
const Proposed = defineDoc<{ count: number }>({
  kind: "gpu-profiles.proposed",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ count: 0 }),
});

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export const GPU_PROFILE_PROMPT = `You can request a GPU workload profile change on ${Object.keys(NODE_FILES).sort().join(" or ")} with propose_profile_change.
- You never run scripts/gpu_profiles/swap.py, kubectl apply, or gaming-on/off yourself; this tool opens a PR instead. A person reviews CI (validate-gpu-workloads.py) and merges; the node's deploy workflow converges it then.
- Give a reason that explains why the new profile is needed. The tool computes the VRAM/GPU-count arithmetic itself from the catalog; if the profile does not fit the node's budget, it refuses before opening anything.
- If a profile-change PR for this node is already open, your request is added to it as a comment instead of a second PR.`;

// The extension is always registered (like homelab-incident) so the agent's extension list and its selection are
// stable whether or not this device has GITOPS_* set; only the tool inside it is conditional.
export function createGpuProfiles(sessionId: string, gitops = gitopsConfig()) {
  const tools: ToolRegistration[] = [];
  if (gitops) {
    // No replay policy: a crash mid-call returns an interrupted result and never opens a second PR.
    const proposeProfileChangeTool = defineTool({
      name: "propose_profile_change",
      description: `Open a pull request on homelab-gitops switching ${Object.keys(NODE_FILES).sort().join(" or ")} to a different GPU workload profile, then notify. Writes only a new jev/gpu-<node>-<ts> branch touching that node's workloads.yaml active_profile: line; a person reviews and merges, and the deploy workflow converges the node. Refuses a profile that is not declared or does not fit the node's GPU-count/VRAM budget. If a profile-change PR for this node is already open, comments on it instead. Works ${PROFILE_LIMIT} times per agent.`,
      parameters: Type.Object({
        node: Type.Union(Object.keys(NODE_FILES).map((n) => Type.Literal(n))),
        profile: Type.String({ description: "a profile name declared in that node's workloads.yaml, e.g. ollama or off" }),
        reason: Type.String({ description: "why this profile is needed now" }),
      }),
      execute: async (args, api, ctx) => {
        await api.commit(async (tx) => {
          const doc = await tx.doc(Proposed, api.conversationId);
          if (doc.count >= PROFILE_LIMIT) throw Error(`propose_profile_change already used ${PROFILE_LIMIT} times by this agent`);
          doc.count++;
        }, ctx);
        const r = await proposeProfileChange(gitops, args as ProfileArgs, { session: sessionId });
        api.output(`${r.kind} PR #${r.number}: ${r.url}\n`);
        const what = r.kind === "opened" ? `Opened PR #${r.number} from ${r.branch}` : `A profile-change PR for ${args.node} was already open; added this request as a comment`;
        return { content: [{ type: "text", text: `${what}: ${r.url}. ${clip(args.reason, 300)}` }] };
      },
    });
    tools.push(proposeProfileChangeTool as ToolRegistration);
  }

  return defineExtension({
    name: GPU_PROFILE_NAME,
    tools,
    sections: [section(GPU_PROFILE_NAME, async () => (gitops ? GPU_PROFILE_PROMPT : undefined), { tag: false })],
  });
}
