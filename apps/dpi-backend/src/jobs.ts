// Durable jobs: repeatable workflows an agent (run_durable_job) or a person (Tasks tab) can start.
//
// Each job is one pi-durable task definition whose checkpoint phases are the job's named phases, so the task graph,
// the run record and the chat card all name the same phase. A phase does real work (shell commands in the session's
// folder, a subagent with read and bash, App State writes), records every step in the conversation document
// `demo.job-runs`, then commits the next checkpoint. A restart resumes the unfinished phase from its checkpoint.
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  configure,
  defineDoc,
  defineTask,
  type ConversationId,
  type RunningTask,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { CodingTools, createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";
import { readState } from "../../dpi-sdk/src/app-state.js";
import type { WireAssistantMessage, WireMessage, WireToolResultMessage } from "../../dpi-sdk/src/api.js";
import { messageText } from "../../dpi-sdk/src/transcript.js";
import {
  JOB_RUNS_DOC,
  type JobDef,
  type JobInputValue,
  type JobPhaseRun,
  type JobRun,
  type JobRunsDoc,
  type JobStep,
  type JobStepKind,
} from "../../dpi-sdk/src/jobs.js";
import type { SharedState } from "./shared-state.js";
import { hardDeny } from "./guard.js";
import {
  backupsListArgv,
  execAsDrill,
  newestCompletedBackup,
  parseBackups,
  parsePodVolumeBackups,
  parseRestoreStatus,
  parseScratchCounts,
  podVolumeBackupsArgv,
  restoreCreateArgv,
  restoreGetArgv,
  restoreIsDone,
  scratchNamespace,
  scratchNamespaceCreateArgv,
  scratchNamespaceDeleteArgv,
  scratchPodsAndPvcsArgv,
  type BackupPlan,
} from "./velero.js";

export const JobRuns = defineDoc<JobRunsDoc>({
  kind: JOB_RUNS_DOC,
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ counts: {}, items: {} }),
});

type Values = Record<string, JobInputValue>;
type Data = Record<string, JsonValue>;
type JobInput = { job: string; input: Values };
type Checkpoint = { phase: string; iteration: number; data: Data; approvalTask?: number };
type JobResult = { summary: string };
type Run = TaskRuntime<JobInput, Checkpoint, JobResult, object>;
type Running = RunningTask<JobInput, Checkpoint, JobResult>;

/** Pause before each phase so a person can follow the run; durable, so a restart keeps the schedule. */
const PACE_MS = 900;
const MAX_RUNS = 30;
const MAX_STEPS = 40;
const RESULT_ROOT = "jobs";

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const tail = (s: string, lines = 8) => s.trim().split("\n").slice(-lines).join("\n");
const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

// ------------------------------------------------------------------ definitions

export const JOB_DEFS: JobDef[] = [
  {
    id: "workspace-snapshot",
    title: "Workspace snapshot",
    summary: "Scan a folder, measure it and save a snapshot to App State. The same four phases every run.",
    phases: [
      { id: "scan", label: "Scan", summary: "Read the git branch, changed files and top-level entries" },
      { id: "measure", label: "Measure", summary: "Count files by extension" },
      { id: "save", label: "Save", summary: "Write the snapshot to App State" },
      { id: "verify", label: "Verify", summary: "Read App State back and compare it with this run" },
    ],
    inputs: [
      { name: "path", type: "string", default: ".", description: "Folder to snapshot, relative to the agent's working directory" },
    ],
    approval: false,
    resultPath: `/${RESULT_ROOT}/workspace-snapshot`,
    seconds: 5,
  },
  {
    id: "release-check",
    title: "Release check",
    summary:
      "Plan a release review, let a subagent gather facts with read and bash, wait for your approval, then publish the notes to App State and verify them.",
    phases: [
      { id: "plan", label: "Plan", summary: "Decide what the release notes must cover" },
      { id: "gather", label: "Gather", summary: "A subagent runs git and reads the README" },
      { id: "approve", label: "Approve", summary: "Wait for a person to approve publishing", kind: "approval" },
      { id: "publish", label: "Publish", summary: "Write the release notes to App State" },
      { id: "verify", label: "Verify", summary: "Read the notes back and confirm this run published them" },
    ],
    inputs: [
      { name: "commits", type: "integer", default: 5, min: 1, max: 20, description: "How many recent commits the subagent reviews" },
    ],
    approval: true,
    resultPath: `/${RESULT_ROOT}/release-check`,
    seconds: 20,
  },
  {
    id: "change-watch",
    title: "Change watch",
    summary:
      "Take a baseline of a folder, check it again on a fixed interval with one checkpoint per check, then report what changed. Close the browser or restart the device mid-run; it resumes.",
    phases: [
      { id: "baseline", label: "Baseline", summary: "Checksum every file up to two levels deep" },
      { id: "watch", label: "Watch", summary: "Re-check on an interval, one checkpoint per check", kind: "repeat" },
      { id: "report", label: "Report", summary: "Save what changed to App State" },
    ],
    inputs: [
      { name: "path", type: "string", default: ".", description: "Folder to watch, relative to the agent's working directory" },
      { name: "checks", type: "integer", default: 5, min: 2, max: 20, description: "How many checks the watch phase runs" },
      { name: "interval_seconds", type: "integer", default: 4, min: 2, max: 60, description: "Seconds between checks" },
    ],
    approval: false,
    resultPath: `/${RESULT_ROOT}/change-watch`,
    seconds: 25,
  },
  {
    id: "approve-irreversible",
    title: "Approve an irreversible step",
    summary:
      "Run one shell command that homelab-guard blocked, but only after a person approves it in the playground. Posts the request to ntfy with a link. Hard-denied commands never run.",
    phases: [
      { id: "request", label: "Request", summary: "Check the command against the hard-deny list and post the approval request" },
      { id: "approve", label: "Approve", summary: "Wait for a person to approve in the playground", kind: "approval" },
      { id: "execute", label: "Execute", summary: "Run the approved command once" },
    ],
    inputs: [
      { name: "command", type: "string", default: "", description: "The exact shell command to run after approval" },
      { name: "reason", type: "string", default: "", description: "Why this step is needed, shown to the approver" },
    ],
    approval: true,
    resultPath: `/${RESULT_ROOT}/approve-irreversible`,
    seconds: 10,
  },
  {
    id: "velero-restore-drill",
    title: "Velero restore drill",
    summary:
      "Restore a namespace's newest backup into a scratch namespace, verify what came back against the plan, then delete the scratch namespace once you approve. The quarterly drill (velero-restore-runbook.md §7), runnable on demand. Never touches the source namespace.",
    phases: [
      { id: "pick", label: "Pick", summary: "Choose the newest Completed backup for the namespace and location" },
      { id: "plan", label: "Plan", summary: "List the resources and PVCs the backup would restore" },
      { id: "approve", label: "Approve", summary: "Wait for a person to approve the restore", kind: "approval" },
      { id: "restore", label: "Restore", summary: "Create a Velero Restore into a scratch namespace" },
      { id: "verify", label: "Verify", summary: "Wait for the restore to finish and diff it against the plan" },
      { id: "cleanup-approve", label: "Approve cleanup", summary: "Wait for a person to approve deleting the scratch namespace", kind: "approval" },
      { id: "cleanup", label: "Cleanup", summary: "Delete the scratch namespace once" },
    ],
    inputs: [
      { name: "namespace", type: "string", default: "", description: "Source namespace to drill-restore. Read only; never modified or deleted." },
      { name: "location", type: "string", default: "seaweedfs", description: "Velero BackupStorageLocation to restore from, e.g. seaweedfs or backblaze" },
    ],
    approval: true,
    resultPath: `/${RESULT_ROOT}/velero-restore-drill`,
    seconds: 180,
  },
];

export const jobDef = (id: string) => JOB_DEFS.find((d) => d.id === id);

/** Validate a job's input against its spec, filling defaults. Throws a message the caller can show as is. */
export function resolveJobInput(def: JobDef, raw: unknown): Values {
  const given = (raw ?? {}) as Record<string, unknown>;
  if (typeof given !== "object" || Array.isArray(given)) throw Error("input must be an object");
  const unknown = Object.keys(given).filter((k) => !def.inputs.some((i) => i.name === k));
  if (unknown.length)
    throw Error(`${def.id} has no input ${unknown.join(", ")}. Inputs: ${def.inputs.map((i) => i.name).join(", ") || "none"}`);
  const out: Values = {};
  for (const spec of def.inputs) {
    const value = given[spec.name] ?? spec.default;
    if (spec.type === "integer") {
      const n = typeof value === "string" && value.trim() ? Number(value) : value;
      if (typeof n !== "number" || !Number.isInteger(n)) throw Error(`${spec.name} must be an integer`);
      if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max))
        throw Error(`${spec.name} must be ${spec.min} to ${spec.max}`);
      out[spec.name] = n;
    } else {
      if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw Error(`${spec.name} must be a non-empty string`);
      out[spec.name] = value.trim();
    }
  }
  return out;
}

// ------------------------------------------------------------------ the phase API job handlers use

interface Phase {
  readonly input: Values;
  readonly data: Data;
  readonly iteration: number;
  readonly run: { id: number; n: number };
  /** Where the run lives, for links back to its approval card. */
  readonly where: { sessionId: string; conversationId: number };
  now(): number;
  /** Run a shell command in the session's folder and record it as a step. Throws on a non-zero exit. */
  exec(command: string, label?: string): Promise<string>;
  /** Run a shell command without recording it. */
  shell(command: string): Promise<{ code: number; out: string }>;
  step<T>(kind: JobStepKind, label: string, fn: () => Promise<{ value: T; detail?: string }>): Promise<T>;
  note(label: string, detail?: string): Promise<void>;
  progress(done: number, total: number): Promise<void>;
  saveState(path: string, value: JsonValue): Promise<void>;
  readState(path: string): Promise<JsonValue | undefined>;
  /** Run a subagent with read and bash in an owned child conversation; its tool calls become steps. */
  agent(prompt: string): Promise<string>;
  sleepUntil(at: number): Promise<void>;
}

type Outcome = { done: string; data?: Data } | { again: Data; summary?: string };
type Handler = (p: Phase) => Promise<Outcome>;

const inDir = (dir: string, command: string) => (dir === "." ? command : `cd ${q(dir)} && ${command}`);
const label = (dir: string, command: string) => (dir === "." ? command : `${command}  (in ${dir})`);
const FIND = `find . -maxdepth 2 -type f -not -path '*/.git/*' -not -path '*/node_modules/*'`;

const HANDLERS: Record<string, Record<string, Handler>> = {
  "workspace-snapshot": {
    scan: async (p) => {
      const dir = String(p.input.path);
      const branch = (
        await p.exec(inDir(dir, `git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "(not a git repo)"`), label(dir, "git rev-parse --abbrev-ref HEAD"))
      ).trim();
      const changed = (await p.exec(inDir(dir, "git status --short 2>/dev/null | head -50"), label(dir, "git status --short")))
        .split("\n")
        .filter(Boolean).length;
      const entries = (await p.exec(inDir(dir, "ls -1A | head -200"), label(dir, "ls -1A"))).split("\n").filter(Boolean).length;
      return { done: `${branch}, ${changed} changed, ${entries} entries`, data: { branch, changed, entries } };
    },
    measure: async (p) => {
      const dir = String(p.input.path);
      const count = Number(
        (await p.exec(inDir(dir, `find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | wc -l`), label(dir, "find . -type f | wc -l"))).trim(),
      );
      const raw = await p.exec(
        inDir(
          dir,
          `find . -type f -not -path '*/.git/*' -not -path '*/node_modules/*' | sed -n 's/.*\\/[^/]*\\.\\([A-Za-z0-9]\\{1,8\\}\\)$/\\1/p' | sort | uniq -c | sort -rn | head -6`,
        ),
        label(dir, "count files by extension"),
      );
      const top = raw
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts.length === 2)
        .map(([n, ext]) => ({ ext, count: Number(n) }));
      return {
        done: `${count} files${top.length ? `: ${top.map((t) => `${t.ext} ${t.count}`).join(", ")}` : ""}`,
        data: { files: count, top },
      };
    },
    save: async (p) => {
      await p.saveState(`/${RESULT_ROOT}/workspace-snapshot`, {
        run: p.run.n,
        at: new Date(p.now()).toISOString(),
        folder: String(p.input.path),
        branch: p.data.branch ?? null,
        changed: p.data.changed ?? 0,
        entries: p.data.entries ?? 0,
        files: p.data.files ?? 0,
        top: p.data.top ?? [],
      });
      return { done: `Saved to App State /${RESULT_ROOT}/workspace-snapshot` };
    },
    verify: async (p) => {
      const saved = (await p.readState(`/${RESULT_ROOT}/workspace-snapshot`)) as { run?: number; files?: number } | undefined;
      await p.step("state", `read_state /${RESULT_ROOT}/workspace-snapshot`, async () => {
        if (saved?.run !== p.run.n || saved.files !== p.data.files)
          throw Error(`App State holds run #${saved?.run ?? "none"}, not run #${p.run.n}. Another writer changed it.`);
        return { value: undefined, detail: `run #${saved.run}, ${saved.files} files` };
      });
      return { done: `App State matches run #${p.run.n}` };
    },
  },

  "release-check": {
    plan: async (p) => {
      const checks = [`Last ${p.input.commits} commits`, "Uncommitted changes", "README headline"];
      for (const [i, check] of checks.entries()) await p.note(`Check ${i + 1}: ${check}`);
      return { done: `${checks.length} checks planned`, data: { checks } };
    },
    gather: async (p) => {
      const notes = await p.agent(
        `Release check: gather facts for run #${p.run.n}. Use bash to run \`git log --oneline -${p.input.commits}\` and \`git status --short\`, then read the first 30 lines of README.md if it exists. Reply with at most 5 short lines: what changed recently, what is uncommitted, and the README headline. Do not edit files.`,
      );
      return { done: clip(notes.split("\n").find((l) => l.trim()) ?? "Gathered", 120), data: { notes } };
    },
    approve: async () => {
      throw Error("approval phases run in the engine");
    },
    publish: async (p) => {
      await p.saveState(`/${RESULT_ROOT}/release-check`, {
        run: p.run.n,
        at: new Date(p.now()).toISOString(),
        checks: p.data.checks ?? [],
        notes: p.data.notes ?? "",
        approved: true,
      });
      return { done: `Published to App State /${RESULT_ROOT}/release-check` };
    },
    verify: async (p) => {
      const saved = (await p.readState(`/${RESULT_ROOT}/release-check`)) as { run?: number; notes?: string } | undefined;
      await p.step("state", `read_state /${RESULT_ROOT}/release-check`, async () => {
        if (saved?.run !== p.run.n) throw Error(`App State holds run #${saved?.run ?? "none"}, not run #${p.run.n}.`);
        return { value: undefined, detail: `run #${saved.run}, ${saved.notes?.length ?? 0} characters of notes` };
      });
      return { done: `Release notes for run #${p.run.n} are live` };
    },
  },

  "change-watch": {
    baseline: async (p) => {
      const dir = String(p.input.path);
      const sums = await p.step("command", label(dir, "cksum every file (2 levels)"), async () => {
        const r = await p.shell(inDir(dir, `${FIND} -exec cksum {} + 2>/dev/null | head -300`));
        const map = checksums(r.out);
        return { value: map, detail: `${Object.keys(map).length} files` };
      });
      return {
        done: `Baseline of ${Object.keys(sums).length} files`,
        data: { sums, changes: [], nextAt: p.now() + Number(p.input.interval_seconds) * 1000 },
      };
    },
    watch: async (p) => {
      const dir = String(p.input.path);
      const total = Number(p.input.checks);
      const n = p.iteration + 1;
      await p.sleepUntil(Number(p.data.nextAt ?? 0));
      const before = (p.data.sums ?? {}) as Record<string, string>;
      const { sums, found } = await p.step("checkpoint", `Check ${n}/${total}`, async () => {
        const r = await p.shell(inDir(dir, `${FIND} -exec cksum {} + 2>/dev/null | head -300`));
        const now = checksums(r.out);
        const diff = [
          ...Object.keys(now).filter((f) => !(f in before)).map((f) => `+ ${f}`),
          ...Object.keys(before).filter((f) => !(f in now)).map((f) => `- ${f}`),
          ...Object.keys(now).filter((f) => f in before && before[f] !== now[f]).map((f) => `~ ${f}`),
        ];
        return {
          value: { sums: now, found: diff },
          detail: diff.length ? `${diff.length} change${diff.length === 1 ? "" : "s"}: ${clip(diff.join(", "), 200)}` : "No changes. Checkpoint saved.",
        };
      });
      await p.progress(n, total);
      const changes = [...((p.data.changes ?? []) as string[]), ...found].slice(-100);
      if (n < total)
        return { again: { sums, changes, nextAt: p.now() + Number(p.input.interval_seconds) * 1000 } };
      return { done: `${total} checks, ${changes.length} change${changes.length === 1 ? "" : "s"}`, data: { sums: {}, changes } };
    },
    report: async (p) => {
      const changes = (p.data.changes ?? []) as string[];
      await p.saveState(`/${RESULT_ROOT}/change-watch`, {
        run: p.run.n,
        at: new Date(p.now()).toISOString(),
        folder: String(p.input.path),
        checks: Number(p.input.checks),
        changes,
      });
      return { done: changes.length ? `${changes.length} changes saved to App State` : "No changes. Report saved to App State" };
    },
  },
};

// approve-irreversible env: DPI_APPROVAL_NTFY_URL (topic URL to post the request to; unset = playground card only)
// and DPI_APPROVAL_URL (the playground's public URL, linked from the message). The approval itself only happens
// in the playground, behind its login: a tap-to-approve ntfy action would let anyone who can read the topic approve.
HANDLERS["approve-irreversible"] = {
  request: async (p) => {
    const command = String(p.input.command).trim();
    const reason = String(p.input.reason).trim();
    if (!command) throw Error("command is required");
    if (!reason) throw Error("reason is required");
    const denied = hardDeny(command);
    if (denied) throw Error(`hard-deny: ${denied}. Approval cannot override this.`);
    const topic = process.env.DPI_APPROVAL_NTFY_URL;
    if (topic)
      await p.step("tool", "notify the approver (ntfy)", async () => {
        const link = process.env.DPI_APPROVAL_URL;
        const res = await fetch(topic, {
          method: "POST",
          headers: {
            Title: `Approval needed: job run #${p.run.n} (session ${p.where.sessionId.slice(0, 8)})`,
            Priority: "high",
            Tags: "warning,lock",
            ...(link ? { Click: link, Actions: `view, Review in playground, ${link}` } : {}),
          },
          body: clip(`${reason}\n\n$ ${command}`, 1500),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw Error(`ntfy HTTP ${res.status}`);
        return { value: undefined, detail: topic };
      });
    return { done: clip(`Waiting on approval for: ${command}`, 120), data: { command } };
  },
  approve: async () => {
    throw Error("approval phases run in the engine");
  },
  execute: async (p) => {
    const command = String(p.data.command);
    const out = await p.exec(command);
    await p.saveState(`/${RESULT_ROOT}/approve-irreversible`, {
      run: p.run.n,
      at: new Date(p.now()).toISOString(),
      command,
      output: clip(out, 2000),
    });
    return { done: clip(`Ran: ${command}`, 120) };
  },
};

// velero-restore-drill: every kubectl/velero call is built by velero.ts from validated parts (argv arrays run
// through execFile), never a shell string. The namespace it writes to is generated by scratchNamespace() from the
// run's own task id, never user input, and every write-side argv builder refuses a target outside that prefix
// (assertScratch, in velero.ts) — so this job can never touch the source namespace.
HANDLERS["velero-restore-drill"] = {
  pick: async (p) => {
    const namespace = String(p.input.namespace);
    const location = String(p.input.location);
    const backups = await p.step("command", "kubectl get backups.velero.io", async () => {
      const { bin, argv } = backupsListArgv();
      const out = await execAsDrill(bin, argv);
      return { value: parseBackups(out), detail: `${JSON.parse(out).items?.length ?? 0} backups` };
    });
    const backup = newestCompletedBackup(backups, namespace, location);
    if (!backup) throw Error(`No Completed backup at location ${JSON.stringify(location)} covers namespace ${JSON.stringify(namespace)}`);
    const scratch = scratchNamespace(namespace, p.run.id);
    return {
      done: `Picked ${backup.name} (completed ${backup.completionTimestamp}) → scratch namespace ${scratch}`,
      data: { namespace, location, backupName: backup.name, scratch, restoreName: scratch },
    };
  },
  plan: async (p) => {
    const backupName = String(p.data.backupName);
    const plan = await p.step("command", "kubectl get podvolumebackups.velero.io", async () => {
      const { bin, argv } = podVolumeBackupsArgv(backupName);
      const out = await execAsDrill(bin, argv);
      const parsed = parsePodVolumeBackups(out);
      return { value: parsed, detail: `${parsed.pods.length} pods, ${parsed.volumes.length} volumes` };
    });
    await p.saveState(`/${RESULT_ROOT}/velero-restore-drill`, {
      run: p.run.n,
      at: new Date(p.now()).toISOString(),
      namespace: p.data.namespace,
      location: p.data.location,
      backupName,
      scratch: p.data.scratch,
      plan: { pods: plan.pods.length, volumes: plan.volumes.length },
      status: "planned",
    });
    return { done: `Plan: ${plan.pods.length} pods, ${plan.volumes.length} volumes`, data: { plan } };
  },
  approve: async () => {
    throw Error("approval phases run in the engine");
  },
  restore: async (p) => {
    const restoreName = String(p.data.restoreName);
    const backupName = String(p.data.backupName);
    const namespace = String(p.data.namespace);
    const scratch = String(p.data.scratch);
    // Pre-create the scratch namespace ourselves (rather than letting `velero restore create` auto-create it), so
    // this is a real namespace create by this job's ServiceAccount, scoped by RBAC/admission to the velero-drill-
    // prefix. A resumed phase after a crash here may find it already created; that is success, not an error.
    await p.step("command", "kubectl create namespace (scratch)", async () => {
      const { bin, argv } = scratchNamespaceCreateArgv(scratch);
      try {
        const out = await execAsDrill(bin, argv);
        return { value: out, detail: tail(out) || "created" };
      } catch (e) {
        if (/AlreadyExists/.test(String((e as Error)?.message))) return { value: "", detail: `${scratch} already exists (resumed)` };
        throw e;
      }
    });
    // Same tolerance here: a resumed phase may have already submitted this Restore before the earlier crash.
    await p.step("command", "velero restore create", async () => {
      const { bin, argv } = restoreCreateArgv({ restoreName, backupName, sourceNamespace: namespace, scratch });
      try {
        const out = await execAsDrill(bin, argv);
        return { value: out, detail: tail(out) || "created" };
      } catch (e) {
        if (/AlreadyExists/.test(String((e as Error)?.message))) return { value: "", detail: `${restoreName} already submitted (resumed)` };
        throw e;
      }
    });
    return { done: `Restore ${restoreName} created into ${scratch}` };
  },
  verify: async (p) => {
    const restoreName = String(p.data.restoreName);
    const scratch = String(p.data.scratch);
    const status = await p.step("command", "poll velero restore phase", async () => {
      const deadline = p.now() + 10 * 60_000;
      for (;;) {
        const { bin, argv } = restoreGetArgv(restoreName);
        const out = await execAsDrill(bin, argv);
        const s = parseRestoreStatus(out);
        if (restoreIsDone(s)) return { value: s, detail: `phase ${s.phase}, ${s.warnings} warnings, ${s.errors} errors` };
        if (p.now() > deadline) throw Error(`restore ${restoreName} did not finish within 10m (last phase ${s.phase})`);
        await p.sleepUntil(p.now() + 5000);
      }
    });
    if (status.phase === "Failed") throw Error(`restore ${restoreName} failed: ${status.errors} error(s) (velero restore describe ${restoreName} --details)`);
    const counts = await p.step("command", "kubectl get pods,pvc -n (scratch)", async () => {
      const { bin, argv } = scratchPodsAndPvcsArgv(scratch);
      const out = await execAsDrill(bin, argv);
      const parsed = parseScratchCounts(out);
      return { value: parsed, detail: `${parsed.pods} pods, ${parsed.pvcsBound}/${parsed.pvcs} PVCs bound` };
    });
    const plan = (p.data.plan ?? { pods: [], volumes: [] }) as BackupPlan;
    await p.saveState(`/${RESULT_ROOT}/velero-restore-drill`, {
      run: p.run.n,
      at: new Date(p.now()).toISOString(),
      namespace: p.data.namespace,
      location: p.data.location,
      backupName: p.data.backupName,
      scratch,
      plan: { pods: plan.pods.length, volumes: plan.volumes.length },
      restored: counts,
      restorePhase: status.phase,
      status: status.phase === "Completed" ? "verified" : "partial",
    });
    return {
      done: `Restore ${status.phase}: ${counts.pods} pods, ${counts.pvcsBound}/${counts.pvcs} PVCs bound (planned ${plan.pods.length} pods, ${plan.volumes.length} volumes)`,
      data: { restorePhase: status.phase, restored: counts },
    };
  },
  "cleanup-approve": async () => {
    throw Error("approval phases run in the engine");
  },
  cleanup: async (p) => {
    const scratch = String(p.data.scratch);
    await p.step("command", "kubectl delete namespace (scratch)", async () => {
      const { bin, argv } = scratchNamespaceDeleteArgv(scratch);
      const out = await execAsDrill(bin, argv);
      return { value: out, detail: tail(out) || "deleted" };
    });
    const plan = (p.data.plan ?? { pods: [], volumes: [] }) as BackupPlan;
    await p.saveState(`/${RESULT_ROOT}/velero-restore-drill`, {
      run: p.run.n,
      at: new Date(p.now()).toISOString(),
      namespace: p.data.namespace,
      location: p.data.location,
      backupName: p.data.backupName,
      scratch,
      plan: { pods: plan.pods.length, volumes: plan.volumes.length },
      restored: p.data.restored ?? null,
      restorePhase: p.data.restorePhase ?? null,
      status: "cleaned-up",
    });
    return { done: `Deleted scratch namespace ${scratch}` };
  },
};

function checksums(out: string) {
  const map: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (m) map[m[3].replace(/^\.\//, "")] = `${m[1]}:${m[2]}`;
  }
  return map;
}

// ------------------------------------------------------------------ run record helpers

async function runOf(tx: Tx, task: { id: TaskId; conversationId: ConversationId }) {
  const run = (await tx.doc(JobRuns, task.conversationId)).items[String(task.id)];
  if (!run) throw Error(`Job run ${task.id} has no record`);
  return run;
}

function upsertStep(phase: JobPhaseRun, step: JobStep) {
  const found = phase.steps.find((s) => s.id === step.id);
  if (found) Object.assign(found, step);
  else {
    phase.steps.push(step);
    if (phase.steps.length > MAX_STEPS) phase.steps = plain(phase.steps.slice(-MAX_STEPS));
  }
}

/** End a run early: the current phase gets `status`, later phases are skipped. */
function endRun(run: JobRun, index: number, status: "failed" | "aborted", runStatus: JobRun["status"], message: string, now: number) {
  run.status = runStatus;
  run.error = message;
  run.endedAt = now;
  run.phases.forEach((phase, i) => {
    if (i === index && phase.status !== "done") {
      phase.status = status;
      phase.endedAt = now;
      phase.summary = message;
      for (const step of phase.steps) if (step.status === "running" || step.status === "waiting") step.status = "error";
    } else if (i > index || (i === index && phase.status === "pending")) phase.status = "skipped";
  });
  if (run.approval === "pending") run.approval = "cancelled";
}

// ------------------------------------------------------------------ the engine

export interface JobsDeps {
  shared: SharedState;
  sessionId: string;
}

const CHILD_INSTRUCTIONS =
  "You are one phase of a durable job. Use only the commands and files the task names. Never edit or write files. Answer in at most 5 short lines.";

export function createJobs(deps: JobsDeps) {
  const Approval = defineTask<{ runId: number }, { phase: "wait" }, { approved: boolean }>({
    name: "demo.job-approval",
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      // Reads the run's decision every 500 ms without writing; the button click is the only write.
      wait: async (task, runtime, ctx) => {
        for (;;) {
          const doc = await runtime.snapshot(JobRuns, task.conversationId, ctx);
          const decision = doc?.items[String(task.input.runId)]?.approval;
          if (decision && decision !== "pending") {
            await runtime.commit(
              () => ({ status: "terminal", outcome: { status: "completed", result: { approved: decision === "approved" } } }),
              ctx,
            );
            return;
          }
          await runtime.sleep(runtime.now() + 500, ctx);
        }
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx);
    },
  });

  const phaseApi = (def: JobDef, index: number, task: Running, runtime: Run, ctx: Context, run: JobRun): Phase => {
    const spec = def.phases[index];
    const cp = task.state.checkpoint;
    let counter = 0;
    const record = (fn: (run: JobRun, phase: JobPhaseRun) => void) =>
      runtime.commit(async (tx) => {
        const current = await runOf(tx, task);
        fn(current, current.phases[index]);
        current.updatedAt = runtime.now();
        return undefined;
      }, ctx);
    const shell = async (command: string) => {
      const env = await runtime.env(ctx);
      if (!env) throw Error("This session has no execution environment");
      let out = "";
      const result = await env.exec(command, { timeout: 60, onOutput: (text) => void (out.length < 50_000 && (out += text)) }, ctx);
      if (!result.ok) throw Error(`${command}: ${result.error.message}`);
      return { code: result.value.exitCode, out };
    };
    const step: Phase["step"] = async (kind, text, fn) => {
      const id = `${spec.id}:${cp.iteration}:${counter++}`;
      const at = runtime.now();
      await record((_r, phase) => upsertStep(phase, { id, kind, label: text, status: "running", iteration: cp.iteration, at }));
      try {
        const { value, detail } = await fn();
        await record((_r, phase) =>
          upsertStep(phase, { id, kind, label: text, status: "done", iteration: cp.iteration, at, ms: runtime.now() - at, ...(detail ? { detail: clip(detail, 600) } : {}) }),
        );
        return value;
      } catch (e) {
        if (!runtime.signal.aborted)
          await record((_r, phase) =>
            upsertStep(phase, { id, kind, label: text, status: "error", iteration: cp.iteration, at, ms: runtime.now() - at, detail: clip(String((e as Error)?.message ?? e), 600) }),
          );
        throw e;
      }
    };
    const stateKey = (path: string) => `job:${deps.sessionId}:${task.id}:${spec.id}:${cp.iteration}:${path}`;
    return {
      input: task.input.input,
      data: cp.data,
      iteration: cp.iteration,
      run: { id: task.id as number, n: run.run },
      where: { sessionId: deps.sessionId, conversationId: task.conversationId as number },
      now: () => runtime.now(),
      shell,
      step,
      exec: (command, text) =>
        step("command", text ?? command, async () => {
          const r = await shell(command);
          if (r.code !== 0) throw Error(`Exit ${r.code}: ${tail(r.out, 4)}`);
          return { value: r.out, detail: tail(r.out) || "(no output)" };
        }),
      note: (text, detail) => step("note", text, async () => ({ value: undefined, detail })),
      progress: (done, total) => record((_r, phase) => void (phase.progress = { done, total })),
      saveState: (path, value) =>
        step("state", `update_state ${path}`, async () => {
          const [, top] = path.split("/");
          const { value: root } = await deps.shared.snapshot();
          const parent = root[top];
          if (!parent || typeof parent !== "object" || Array.isArray(parent))
            await deps.shared.change({ operation: parent === undefined ? "create" : "update", path: `/${top}`, value: {} }, `${stateKey(path)}:parent`);
          const exists = (await deps.shared.snapshot()).value[top] as Record<string, unknown>;
          const key = path.split("/").slice(2).join("/");
          await deps.shared.change(
            { operation: Object.hasOwn(exists ?? {}, key) ? "update" : "create", path, value },
            stateKey(path),
          );
          return { value: undefined, detail: clip(JSON.stringify(value), 300) };
        }),
      readState: async (path) => {
        try {
          return readState((await deps.shared.snapshot()).value, path);
        } catch {
          return undefined;
        }
      },
      sleepUntil: (at) => runtime.sleep(at, ctx),
      agent: async (prompt) => {
        let childId = 0;
        const stepId = `${spec.id}:${cp.iteration}:agent`;
        const at = runtime.now();
        await runtime.commit(async (tx) => {
          const found = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
          if (found) childId = found.id as number;
          else {
            const child = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
            await configure(tx, child.id, {
              extensions: [CodingTools],
              tools: [createReadTool(), createBashTool()],
              instructions: CHILD_INSTRUCTIONS,
            });
            childId = child.id as number;
          }
          const current = await runOf(tx, task);
          current.childConversationId = childId;
          upsertStep(current.phases[index], {
            id: stepId,
            kind: "agent",
            label: `Subagent #${childId}`,
            detail: "Working with read and bash",
            status: "running",
            iteration: cp.iteration,
            at,
            conversationId: childId,
          });
          return undefined;
        }, ctx);
        const handle = await runtime.conversation(childId as ConversationId, ctx);
        if (!handle) throw Error(`Subagent #${childId} is missing`);
        const submission = await handle.submit(
          { type: "input", content: prompt, requestId: `job:${task.id}:${spec.id}` },
          ctx,
        );
        const settled = submission.wait(ctx);
        // Mirror the subagent's tool calls into the run record while it works; each call is its own pi.tool task.
        let seen = "";
        const sync = async () => {
          const view = await runtime.context(childId as ConversationId, ctx);
          const results = new Map<string, boolean>();
          const calls: { id: string; name: string; args: unknown }[] = [];
          for (const entry of view.entries) {
            for (const m of (entry.model ?? []) as unknown as WireMessage[]) {
              if (m.role === "toolResult") {
                const r = m as WireToolResultMessage;
                results.set(r.toolCallId, r.isError);
              }
              if (m.role === "assistant")
                for (const b of (m as WireAssistantMessage).content)
                  if (b.type === "toolCall") calls.push({ id: b.id, name: b.name, args: b.arguments });
            }
          }
          const key = JSON.stringify(calls.map((c) => [c.id, results.get(c.id)]));
          if (key === seen) return view;
          seen = key;
          await record((_r, phase) => {
            for (const c of calls) {
              const id = `${spec.id}:${cp.iteration}:tool:${c.id}`;
              const prior = phase.steps.find((s) => s.id === id);
              const status = !results.has(c.id) ? "running" : results.get(c.id) ? "error" : "done";
              const started = prior?.at ?? runtime.now();
              upsertStep(phase, {
                id,
                kind: "tool",
                label: c.name,
                detail: clip(summarizeArgs(c.args), 160),
                status,
                iteration: cp.iteration,
                at: started,
                conversationId: childId,
                // Only a call seen running has a measured duration; one that finished between polls has none.
                ...(status !== "running" && prior ? { ms: prior.ms ?? runtime.now() - started } : {}),
              });
            }
          });
          return view;
        };
        let done: Awaited<typeof settled> | undefined;
        while (!done) {
          runtime.signal.throwIfAborted();
          done = await Promise.race([
            settled,
            runtime.sleep(runtime.now() + 600, ctx).then(
              () => undefined,
              () => undefined,
            ),
          ]);
          await sync();
        }
        const view = await sync();
        const answer = done.status === "done" && done.type === "input" ? view.entries.find((e) => e.id === done.answer) : undefined;
        const text = answer ? ((answer.model ?? []) as unknown as WireMessage[]).map(messageText).join("").trim() : "";
        await record((_r, phase) =>
          upsertStep(phase, {
            id: stepId,
            kind: "agent",
            label: `Subagent #${childId}`,
            detail: clip(text || `Ended: ${done.status}`, 600),
            status: text ? "done" : "error",
            iteration: cp.iteration,
            at,
            ms: runtime.now() - at,
            conversationId: childId,
          }),
        );
        if (!text) throw Error(`Subagent #${childId} returned no answer (${done.status})`);
        return text;
      },
    };
  };

  /** Advance past phase `index`: the next phase's checkpoint, or the run's completed outcome. */
  const finish = (def: JobDef, index: number, task: Running, runtime: Run, ctx: Context, summary: string, data: Data) =>
    runtime.commit(async (tx) => {
      const run = await runOf(tx, task);
      const now = runtime.now();
      const phase = run.phases[index];
      phase.status = "done";
      phase.endedAt = now;
      phase.summary = summary;
      run.updatedAt = now;
      const next = def.phases[index + 1];
      if (next) {
        run.phase = next.id;
        run.status = "running";
        return { status: "running" as const, checkpoint: { phase: next.id, iteration: 0, data } };
      }
      run.status = "completed";
      run.result = summary;
      run.endedAt = now;
      return { status: "terminal" as const, outcome: { status: "completed" as const, result: { summary } } };
    }, ctx);

  const fail = (index: number, task: Running, runtime: Run, ctx: Context, message: string, runStatus: "failed" | "declined") =>
    runtime.commit(async (tx) => {
      const run = await runOf(tx, task);
      endRun(run, index, "failed", runStatus, message, runtime.now());
      run.updatedAt = runtime.now();
      return { status: "terminal" as const, outcome: { status: "failed" as const, error: { message } } };
    }, ctx);

  async function approvalPhase(def: JobDef, index: number, task: Running, runtime: Run, ctx: Context) {
    const spec = def.phases[index];
    const cp = task.state.checkpoint;
    if (cp.approvalTask === undefined) {
      await runtime.commit(async (tx) => {
        const run = await runOf(tx, task);
        const now = runtime.now();
        const phase = run.phases[index];
        phase.status = "waiting";
        phase.startedAt ??= now;
        run.status = "waiting";
        run.phase = spec.id;
        run.approval = "pending";
        run.updatedAt = now;
        upsertStep(phase, { id: `${spec.id}:0:decision`, kind: "approval", label: "Waiting for your decision", status: "waiting", iteration: 0, at: now });
        const approvalTask = await tx.createTask(Approval, { runId: task.id as number }, { ownership: { kind: "task", taskId: task.id } });
        return { status: "waiting", checkpoint: { ...cp, approvalTask: approvalTask as number }, on: [approvalTask], policy: "allSettled" };
      }, ctx);
      return;
    }
    const [outcome] = await runtime.outcomes([cp.approvalTask as TaskId<{ approved: boolean }>], ctx);
    const approved = outcome.status === "completed" && outcome.result.approved;
    const decided = (status: JobStep["status"], text: string) =>
      runtime.commit(async (tx) => {
        const run = await runOf(tx, task);
        const phase = run.phases[index];
        const step = phase.steps.find((s) => s.id === `${spec.id}:0:decision`);
        if (step) Object.assign(step, { status, label: text, ms: runtime.now() - step.at });
        return undefined;
      }, ctx);
    if (approved) {
      await decided("done", "Approved by you");
      await finish(def, index, task, runtime, ctx, "Approved by you", cp.data);
      return;
    }
    await decided("error", outcome.status === "completed" ? "Declined by you" : "Approval cancelled");
    if (outcome.status === "completed") await fail(index, task, runtime, ctx, "Declined by you", "declined");
    else
      await runtime.commit(async (tx) => {
        const run = await runOf(tx, task);
        endRun(run, index, "aborted", "aborted", "Approval cancelled", runtime.now());
        return { status: "terminal", outcome: { status: "aborted" } };
      }, ctx);
  }

  async function runPhase(def: JobDef, index: number, task: Running, runtime: Run, ctx: Context) {
    const spec = def.phases[index];
    const cp = task.state.checkpoint;
    if (index > 0 && cp.iteration === 0 && cp.approvalTask === undefined) await runtime.sleep(runtime.now() + PACE_MS, ctx);
    if (spec.kind === "approval") return approvalPhase(def, index, task, runtime, ctx);

    // Enter the phase. Steps recorded by this same iteration mean a crash interrupted it: replace them.
    let resumed = false;
    let snapshot: JobRun | undefined;
    await runtime.commit(async (tx) => {
      const run = await runOf(tx, task);
      const phase = run.phases[index];
      const now = runtime.now();
      if (phase.status === "pending") phase.startedAt = now;
      else if (phase.steps.some((s) => s.iteration === cp.iteration)) {
        phase.steps = plain(phase.steps.filter((s) => s.iteration !== cp.iteration));
        run.resumed += 1;
        resumed = true;
      }
      phase.status = "running";
      run.status = "running";
      run.phase = spec.id;
      run.updatedAt = now;
      snapshot = plain(run);
      return undefined;
    }, ctx);
    const p = phaseApi(def, index, task, runtime, ctx, snapshot!);
    if (resumed) await p.note("Resumed from the last checkpoint after a restart");

    let outcome: Outcome;
    try {
      const handler = HANDLERS[def.id]?.[spec.id];
      if (!handler) throw Error(`No handler for ${def.id}/${spec.id}`);
      outcome = await handler(p);
    } catch (e) {
      if (runtime.signal.aborted) throw e;
      await fail(index, task, runtime, ctx, clip(String((e as Error)?.message ?? e), 400), "failed");
      return;
    }
    if ("again" in outcome) {
      const data = outcome.again;
      await runtime.commit(async (tx) => {
        const run = await runOf(tx, task);
        if (outcome.summary) run.phases[index].summary = outcome.summary;
        run.updatedAt = runtime.now();
        return { status: "running", checkpoint: { phase: spec.id, iteration: cp.iteration + 1, data } };
      }, ctx);
      return;
    }
    await finish(def, index, task, runtime, ctx, outcome.done, { ...cp.data, ...(outcome.data ?? {}) });
  }

  const tasks = JOB_DEFS.map((def) =>
    defineTask<JobInput, Checkpoint, JobResult>({
      name: `demo.job.${def.id}`,
      version: 1,
      initial: () => ({ phase: def.phases[0].id, iteration: 0, data: {} }),
      phases: Object.fromEntries(
        def.phases.map((spec, index) => [spec.id, (task: Running, runtime: Run, ctx: Context) => runPhase(def, index, task, runtime, ctx)]),
      ),
      abort: async (task, runtime, ctx) => {
        await runtime.commit(async (tx) => {
          const run = await runOf(tx, task);
          const index = Math.max(0, def.phases.findIndex((p) => p.id === task.state.checkpoint.phase));
          endRun(run, index, "aborted", "aborted", "Stopped", runtime.now());
          run.updatedAt = runtime.now();
          return { status: "terminal", outcome: { status: "aborted" } };
        }, ctx);
      },
    }),
  );
  const taskOf = (id: string) => tasks[JOB_DEFS.findIndex((d) => d.id === id)];

  /**
   * Create a run inside a commit: the job's task and its record, together. `owner` makes the run part of that task's
   * work (a run_durable_job call); without it the conversation owns the run in the background.
   */
  async function start(
    tx: Tx,
    conversationId: ConversationId,
    opts: { def: JobDef; input: Values; startedBy: "agent" | "you"; toolCallId?: string; owner?: TaskId; now: number },
  ) {
    const background = opts.owner === undefined;
    const taskId = await tx.createTask(
      taskOf(opts.def.id),
      { job: opts.def.id, input: opts.input },
      { ownership: opts.owner === undefined ? { kind: "conversation" } : { kind: "task", taskId: opts.owner }, background },
    );
    const doc = await tx.doc(JobRuns, conversationId);
    const n = (doc.counts[opts.def.id] ?? 0) + 1;
    doc.counts[opts.def.id] = n;
    doc.items[String(taskId)] = {
      id: taskId as number,
      job: opts.def.id,
      title: opts.def.title,
      run: n,
      input: opts.input,
      startedBy: opts.startedBy,
      ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
      background,
      status: "running",
      phase: opts.def.phases[0].id,
      phases: opts.def.phases.map((p) => ({ id: p.id, label: p.label, status: "pending" as const, steps: [] })),
      resumed: 0,
      startedAt: opts.now,
      updatedAt: opts.now,
    };
    const ids = Object.keys(doc.items).map(Number).sort((a, b) => a - b);
    for (const old of ids.slice(0, Math.max(0, ids.length - MAX_RUNS))) delete doc.items[String(old)];
    return taskId;
  }

  return { defs: JOB_DEFS, tasks: [...tasks, Approval], start };
}

export type Jobs = ReturnType<typeof createJobs>;

function summarizeArgs(args: unknown) {
  if (!args || typeof args !== "object") return String(args ?? "");
  const a = args as Record<string, unknown>;
  if (typeof a.command === "string") return a.command;
  if (typeof a.path === "string") return a.path;
  return JSON.stringify(args);
}
