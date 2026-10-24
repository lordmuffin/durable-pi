// Custom harness extensions an agent can turn on and off. Each is a plain pi-durable extension in the registry; the
// agent's stored selection (`configure({ extensions: { add | remove } })`) decides whether it runs, from the next
// request on. Neither is selected by default.
//
//   system-prompts       a checklist of built-in system prompts, rendered as one section
//   jev-damage-control   Jev judges every bash command before it runs and blocks destructive ones
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineDoc, defineExtension, hook, section, ToolTask, type Extension } from "@earendil-works/pi-durable";
import type { HarnessExtensionInfo } from "../../dpi-sdk/src/api.js";
import { askJev, type JevAnswer, type JevQuestion } from "./jev.js";
import { createIncident, INCIDENT_NAME } from "./incident.js";
import { createPrReview, PR_REVIEW_NAME } from "./pr-review.js";
import type { SharedState } from "./shared-state.js";

const PROMPTS_DIR = join(import.meta.dirname, "../prompts");

export const PROMPTS = [
  {
    id: "smart_ass_opus_fix.md",
    title: "Smart Ass Opus fix",
    description: "Clear, concise, actionable communication: the most important point last, no filler, reference codes.",
  },
  {
    id: "one_sentence.md",
    title: "One sentence",
    description: "Replies in one sentence unless you ask for more. Easy to see turn on and off.",
  },
].map((p) => ({ ...p, text: readFileSync(join(PROMPTS_DIR, p.id), "utf8").trim() }));

/** Which built-in prompts this agent's system-prompts extension renders. */
export const PromptChecklist = defineDoc<{ enabled: string[] }>({
  kind: "ext.system-prompts",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ enabled: [PROMPTS[0].id] }),
});

// ------------------------------------------------------------------ jev-damage-control

/** The jev-bash gate's questions and thresholds (harness/extensions/jev-bash/bash-gate.ts). */
export const BASH_QUESTIONS: Record<string, JevQuestion> = {
  effect: {
    type: "choice",
    instructions: "What does running `command` do to the machine?",
    criteria: {
      read_only: "Lists, reads, searches, tests, builds into a scratch directory; nothing durable changes",
      reversible: "Changes files or state that git or a reinstall can restore: edits, installs, generated output",
      irreversible:
        "Deletes or overwrites things with no way back: removing directories, force pushing, dropping data, rewriting history",
    },
  },
  destructive_intent: {
    type: "noul",
    instructions: "Does `command` aim to remove or wipe something rather than build or inspect?",
    criteria: {
      true: "rm -rf, drop, purge, force, reset --hard, truncate, overwriting real data",
      false: "Reading, listing, testing, installing, generating, or editing in place",
    },
  },
};

type Verdict = { block: boolean; reason: string };

export function gate(a: Record<string, JevAnswer>): Verdict {
  const effect = a.effect as Extract<JevAnswer, { type: "choice" }>;
  const destructive = (a.destructive_intent as Extract<JevAnswer, { type: "noul" }>).noul;
  if (effect.choice === "irreversible" && effect.confidence >= 0.6)
    return { block: true, reason: `irreversible (${effect.confidence.toFixed(2)}): nothing would restore what this removes or overwrites` };
  if (destructive >= 0.7)
    return { block: true, reason: `destructive intent (${destructive.toFixed(2)}): this command aims to wipe something` };
  return { block: false, reason: `${effect.choice} (${effect.confidence.toFixed(2)}), destructive ${destructive.toFixed(2)}` };
}

/** The faux provider's stand-in for Jev, so tests and offline demos never call the network. */
const OFFLINE_DANGER = /\brm\s+-[a-z]*[rf]|\bgit\s+push\b.*--force|\bgit\s+reset\s+--hard|\bdropdb\b|\bmkfs|\bdd\s+.*of=|\btruncate\b/;
export async function judgeOffline(command: string): Promise<Verdict> {
  return OFFLINE_DANGER.test(command)
    ? { block: true, reason: "destructive intent (offline rules): this command aims to wipe something" }
    : { block: false, reason: "allowed (offline rules)" };
}

// ------------------------------------------------------------------ the extensions

export const ADDON_INFO: Omit<HarnessExtensionInfo, "enabled" | "prompts">[] = [
  {
    name: "system-prompts",
    title: "System prompts",
    description: "Adds the checked prompts to this agent's system prompt. A change applies from the next request.",
  },
  {
    name: "jev-damage-control",
    title: "Jev damage control",
    description:
      "Before every bash call, Jev judges the command in about 300 ms and blocks irreversible or destructive ones. The decision is a durable memo, so a restart never re-asks. If Jev is down, commands run.",
  },
  {
    name: INCIDENT_NAME,
    title: "Homelab incident",
    description:
      "k8s_read (kubectl get/describe/logs, flux get as a view-only ServiceAccount), save_rca (App State /incidents only) and notify (ntfy). With GITOPS_* set, also gitops_read and propose_fix (a fix PR on homelab-gitops for a person to merge). Pair it with Read only.",
  },
  {
    name: PR_REVIEW_NAME,
    title: "Homelab PR review",
    description:
      "Started by Jev's POST /forgejo for a labelled or jev/ pull request on homelab-gitops. pr_checks (kubectl kustomize plus a tests/tdd subset against a fetched scratch checkout) and pr_comment (one comment per PR, edited in place on a later push). No approve, merge or label change. Offered only with REVIEW_API/REVIEW_REPO/REVIEW_TOKEN set. Pair it with Read only.",
  },
];

export function createAddons(opts: { offline: boolean; shared: SharedState; sessionId: string }) {
  const prompts = defineExtension({
    name: "system-prompts",
    sections: [
      section(
        "system-prompts",
        async (input, ctx) => {
          const checklist = await input.read.snapshot(PromptChecklist, input.conversationId, ctx);
          const enabled = checklist?.enabled ?? [PROMPTS[0].id];
          const text = PROMPTS.filter((p) => enabled.includes(p.id)).map((p) => p.text);
          return text.length ? text.join("\n\n") : undefined;
        },
        { tag: false },
      ),
    ],
  });
  const judge = opts.offline && !process.env.JEV_BASE_URL ? judgeOffline : async (command: string) => gate(await askJev({ command }, BASH_QUESTIONS));
  const jev = defineExtension({
    name: "jev-damage-control",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, ctx) => {
          if (call.name !== "bash") return;
          const command = String((call.arguments as { command?: unknown }).command ?? "");
          let verdict = await api.memo<Verdict>("jev-damage-control", ctx);
          if (!verdict) {
            try {
              verdict = await api.memo<Verdict>("jev-damage-control", await judge(command), ctx);
            } catch {
              // Fails open (a Jev outage must not stop bash) unless DPI_JEV_FAIL_CLOSED=1.
              if (process.env.DPI_JEV_FAIL_CLOSED === "1")
                return { block: "jev-damage-control: Jev is unreachable, so bash is blocked (DPI_JEV_FAIL_CLOSED=1)" };
              return;
            }
          }
          if (verdict.block) return { block: `jev-damage-control blocked this command: ${verdict.reason}` };
        },
      }),
    ],
  });
  const incident = createIncident(opts.shared, opts.sessionId);
  const prReview = createPrReview();
  const all: Record<string, Extension> = {
    "system-prompts": prompts, "jev-damage-control": jev, [INCIDENT_NAME]: incident, [PR_REVIEW_NAME]: prReview,
  };
  return { all, list: [prompts, jev, incident, prReview] };
}

export type Addons = ReturnType<typeof createAddons>;
