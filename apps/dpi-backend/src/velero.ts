// velero-restore-drill: argv builders and output parsers for the kubectl/velero calls the job makes. Every call is
// built from validated parts here, never a shell string — the same shape as incident.ts's k8sArgv. Exported for tests.
import { execFile } from "node:child_process";

const NAME = /^[a-z0-9]([a-z0-9.\-]{0,251}[a-z0-9])?$/;
const MAX_OUTPUT = 200_000;

export const DRILL_PREFIX = process.env.VELERO_DRILL_PREFIX ?? "velero-drill-";
export const veleroNamespace = () => process.env.VELERO_NAMESPACE ?? "velero";
export const kubectlBin = () => process.env.KUBECTL_BIN ?? "kubectl";
export const veleroBin = () => process.env.VELERO_BIN ?? "velero";

const check = (value: string, pattern: RegExp, what: string) => {
  if (!pattern.test(value)) throw Error(`Invalid ${what}: ${JSON.stringify(value)}`);
  return value;
};

/** The one scratch namespace this run is allowed to write to. Deterministic from the run, never user-chosen. */
export function scratchNamespace(sourceNamespace: string, runId: number): string {
  const ns = check(sourceNamespace, NAME, "namespace");
  return `${DRILL_PREFIX}${ns}-${runId}`;
}

/**
 * Hard-fail guard: every create/delete this job issues must target the scratch namespace it generated itself,
 * never the source namespace or anything else. Called by every argv builder below that writes.
 */
export function assertScratch(target: string): string {
  if (!target.startsWith(DRILL_PREFIX))
    throw Error(`refusing to touch namespace ${JSON.stringify(target)}: it is not a ${DRILL_PREFIX} scratch namespace`);
  return target;
}

export function runBin(bin: string, argv: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, argv, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: process.env }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr ? `\n${stderr}` : ""}`.trim();
      const text = out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}\n… (${out.length - MAX_OUTPUT} more characters cut)` : out;
      const code = (err as { code?: number } | null)?.code;
      if (err && code === undefined && !out) return reject(err);
      resolve({ code: code ?? 0, out: text });
    });
  });
}

/** Run a validated argv and throw with the tail of combined output on a non-zero exit. */
export async function execBin(bin: string, argv: string[]): Promise<string> {
  const { code, out } = await runBin(bin, argv);
  if (code !== 0) throw Error(`${bin} ${argv.join(" ")}: exit ${code}: ${out.trim().split("\n").slice(-8).join("\n")}`);
  return out;
}

// ------------------------------------------------------------------ argv builders (read)

export function backupsListArgv(): { bin: string; argv: string[] } {
  return { bin: kubectlBin(), argv: ["get", "backups.velero.io", "-n", veleroNamespace(), "-o", "json"] };
}

export function podVolumeBackupsArgv(backupName: string): { bin: string; argv: string[] } {
  check(backupName, NAME, "backup name");
  return {
    bin: kubectlBin(),
    argv: ["get", "podvolumebackups.velero.io", "-n", veleroNamespace(), "-l", `velero.io/backup-name=${backupName}`, "-o", "json"],
  };
}

export function restoreGetArgv(restoreName: string): { bin: string; argv: string[] } {
  check(restoreName, NAME, "restore name");
  return { bin: kubectlBin(), argv: ["get", "restores.velero.io", restoreName, "-n", veleroNamespace(), "-o", "json"] };
}

export function scratchPodsAndPvcsArgv(scratch: string): { bin: string; argv: string[] } {
  assertScratch(scratch);
  return { bin: kubectlBin(), argv: ["get", "pods,pvc", "-n", scratch, "-o", "json"] };
}

// ------------------------------------------------------------------ argv builders (write — scratch namespace only)

export function restoreCreateArgv(opts: {
  restoreName: string;
  backupName: string;
  sourceNamespace: string;
  scratch: string;
}): { bin: string; argv: string[] } {
  check(opts.restoreName, NAME, "restore name");
  check(opts.backupName, NAME, "backup name");
  check(opts.sourceNamespace, NAME, "namespace");
  assertScratch(opts.scratch);
  return {
    bin: veleroBin(),
    argv: [
      "restore",
      "create",
      opts.restoreName,
      "-n",
      veleroNamespace(),
      "--from-backup",
      opts.backupName,
      "--include-namespaces",
      opts.sourceNamespace,
      "--namespace-mappings",
      `${opts.sourceNamespace}:${opts.scratch}`,
    ],
  };
}

export function scratchNamespaceDeleteArgv(scratch: string): { bin: string; argv: string[] } {
  assertScratch(scratch);
  return { bin: kubectlBin(), argv: ["delete", "namespace", scratch, "--wait", "--timeout=5m"] };
}

// ------------------------------------------------------------------ output parsing

export type Backup = {
  name: string;
  phase: string;
  location: string;
  includedNamespaces: string[];
  completionTimestamp: string;
};

/** `kubectl get backups.velero.io -o json` → the fields the drill needs. */
export function parseBackups(json: string): Backup[] {
  const parsed = JSON.parse(json) as { items?: unknown[] };
  return (parsed.items ?? []).map((item) => {
    const i = item as {
      metadata?: { name?: string };
      spec?: { storageLocation?: string; includedNamespaces?: string[] };
      status?: { phase?: string; completionTimestamp?: string };
    };
    return {
      name: String(i.metadata?.name ?? ""),
      phase: String(i.status?.phase ?? ""),
      location: String(i.spec?.storageLocation ?? ""),
      includedNamespaces: i.spec?.includedNamespaces ?? [],
      completionTimestamp: String(i.status?.completionTimestamp ?? ""),
    };
  });
}

/** The newest Completed backup at `location` that covers `namespace` ("*" or an empty list means every namespace). */
export function newestCompletedBackup(backups: Backup[], namespace: string, location: string): Backup | undefined {
  return backups
    .filter(
      (b) =>
        b.phase === "Completed" &&
        b.location === location &&
        (b.includedNamespaces.length === 0 || b.includedNamespaces.includes("*") || b.includedNamespaces.includes(namespace)),
    )
    .sort((a, b) => b.completionTimestamp.localeCompare(a.completionTimestamp))[0];
}

export type BackupPlan = { pods: string[]; volumes: { pod: string; volume: string }[] };

/** `kubectl get podvolumebackups.velero.io -l velero.io/backup-name=<name> -o json` → the plan: pods and volumes it covers. */
export function parsePodVolumeBackups(json: string): BackupPlan {
  const parsed = JSON.parse(json) as { items?: unknown[] };
  const volumes = (parsed.items ?? []).map((item) => {
    const i = item as { spec?: { pod?: { name?: string }; volume?: string } };
    return { pod: String(i.spec?.pod?.name ?? ""), volume: String(i.spec?.volume ?? "") };
  });
  const pods = [...new Set(volumes.map((v) => v.pod).filter(Boolean))];
  return { pods, volumes };
}

export type RestoreStatus = { phase: string; warnings: number; errors: number };

/** `kubectl get restores.velero.io <name> -o json` → the fields verify needs to decide done/failed. */
export function parseRestoreStatus(json: string): RestoreStatus {
  const parsed = JSON.parse(json) as { status?: { phase?: string; warnings?: number; errors?: number } };
  return { phase: String(parsed.status?.phase ?? "New"), warnings: Number(parsed.status?.warnings ?? 0), errors: Number(parsed.status?.errors ?? 0) };
}

const RESTORE_DONE = new Set(["Completed", "PartiallyFailed", "Failed"]);
export const restoreIsDone = (status: RestoreStatus) => RESTORE_DONE.has(status.phase);

export type ScratchCounts = { pods: number; pvcs: number; pvcsBound: number };

/** `kubectl get pods,pvc -n <scratch> -o json` → what actually landed in the scratch namespace. */
export function parseScratchCounts(json: string): ScratchCounts {
  const parsed = JSON.parse(json) as { items?: unknown[] };
  const items = parsed.items ?? [];
  const pods = items.filter((it) => (it as { kind?: string }).kind === "Pod");
  const pvcs = items.filter((it) => (it as { kind?: string }).kind === "PersistentVolumeClaim");
  const bound = pvcs.filter((it) => (it as { status?: { phase?: string } }).status?.phase === "Bound");
  return { pods: pods.length, pvcs: pvcs.length, pvcsBound: bound.length };
}
