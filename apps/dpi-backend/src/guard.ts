// homelab-guard: the bash gate every agent on this device carries when DPI_GUARD=on. Not an add-on in the Extend
// tab, so an agent cannot switch it off. Per bash call, in order:
//   1. hard-deny   a fixed list of commands no agent may ever run; no model is asked
//   2. Jev         judges the command (jev.ts); destructive or irreversible ones are blocked
//   3. fail closed if Jev cannot answer (DPI_JEV_FAIL_CLOSED=1, the default with DPI_GUARD=on), the command is blocked
// A blocked irreversible step can still happen: the agent calls run_durable_job with approve-irreversible, which
// pauses for a person's approval in the playground before it runs (jobs.ts). Hard-denied commands never run there
// either. A guard, not a sandbox: it reads the command text, so the real boundary is the pod's ServiceAccount.
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { askJev } from "./jev.js";
import { BASH_QUESTIONS, gate, judgeOffline } from "./addons.js";

export const GUARD_NAME = "homelab-guard";
export const guardEnabled = (env = process.env) => env.DPI_GUARD === "on";
export const failClosed = (env = process.env) => (env.DPI_JEV_FAIL_CLOSED ?? (guardEnabled(env) ? "1" : "0")) === "1";

// One shell segment: the text up to the next ; & | or newline, so a flag in one command never matches another.
const SEG = "[^;&|\\n]*";
export const HARD_DENY: { pattern: RegExp; why: string }[] = [
  { pattern: new RegExp(`\\b(tofu|terraform)\\b${SEG}\\sapply\\b`), why: "tofu/terraform apply changes real infrastructure" },
  { pattern: new RegExp(`\\bzpool\\s+${SEG}(?<![\\w-])(create|destroy)(?![\\w-])`), why: "zpool create/destroy rewrites disks" },
  {
    pattern: new RegExp(`\\bgit\\b${SEG}\\spush\\b${SEG}(\\s(-f|--force|--force-with-lease|--mirror|--delete)\\b|\\s-[a-zA-Z]*f[a-zA-Z]*\\b|\\s\\+|[\\s:/]main(?![\\w./-]))`),
    why: "git push to main or a forced push rewrites shared history",
  },
  { pattern: new RegExp(`\\bkubectl\\b${SEG}\\sdelete(?![\\w-])`), why: "kubectl delete removes live cluster objects" },
];

/** The reason a command is hard-denied, or undefined. */
export function hardDeny(command: string): string | undefined {
  // Fold line continuations so `kubectl \<newline> delete` is one segment.
  const text = command.replace(/\\\r?\n/g, " ");
  return HARD_DENY.find((rule) => rule.pattern.test(text))?.why;
}

type Verdict = { block: boolean; reason: string };

export function createGuard(opts: { offline: boolean }) {
  const judge = opts.offline ? judgeOffline : async (command: string) => gate(await askJev({ command }, BASH_QUESTIONS));
  return defineExtension({
    name: GUARD_NAME,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, ctx) => {
          if (call.name !== "bash") return;
          const command = String((call.arguments as { command?: unknown }).command ?? "");
          const denied = hardDeny(command);
          if (denied) return { block: `${GUARD_NAME} hard-deny: ${denied}. No agent may run this; ask a person to do it.` };
          let verdict = await api.memo<Verdict>(GUARD_NAME, ctx);
          if (!verdict) {
            try {
              verdict = await api.memo<Verdict>(GUARD_NAME, await judge(command), ctx);
            } catch (e) {
              if (!failClosed()) return;
              // Not memoized: the next attempt asks Jev again.
              return { block: `${GUARD_NAME}: Jev is unreachable (${e instanceof Error ? e.message : e}), so bash is blocked. Retry later.` };
            }
          }
          if (verdict.block)
            return {
              block: `${GUARD_NAME} blocked this command: ${verdict.reason}. If it is really needed, call run_durable_job with job "approve-irreversible" and input {"command": <the command>, "reason": <why>}; it runs only after a person approves.`,
            };
        },
      }),
    ],
  });
}
