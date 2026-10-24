// velero-restore-drill: argv/parsing unit tests (pure, no process spawned), then a SIGKILL-mid-restore resume test
// modeled on recovery.test.ts, against fake kubectl/velero binaries so it never touches a real cluster.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DpiClient } from "../../dpi-sdk/src/client.js";
import type { JobRunsDoc } from "../../dpi-sdk/src/jobs.js";
import {
  assertScratch,
  backupsListArgv,
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
  scratchNamespaceDeleteArgv,
  scratchPodsAndPvcsArgv,
} from "../src/velero.js";
import { bootServer, faux, newToken, tempStore, until } from "./helpers.js";

const BACKUPS_JSON = JSON.stringify({
  items: [
    {
      metadata: { name: "velero-offsite-data-20261024040009" },
      spec: { storageLocation: "seaweedfs", includedNamespaces: ["tandoor"] },
      status: { phase: "Completed", completionTimestamp: "2026-10-24T04:00:09Z" },
    },
    {
      metadata: { name: "velero-offsite-data-20261023040009" },
      spec: { storageLocation: "seaweedfs", includedNamespaces: ["tandoor"] },
      status: { phase: "Completed", completionTimestamp: "2026-10-23T04:00:09Z" },
    },
    {
      metadata: { name: "velero-offsite-data-20261024040500" },
      spec: { storageLocation: "backblaze", includedNamespaces: ["tandoor"] },
      status: { phase: "Completed", completionTimestamp: "2026-10-24T04:05:00Z" },
    },
  ],
});

// ------------------------------------------------------------------ pure argv / parsing tests

test("velero.ts: parses backups and picks the newest Completed one at the given location", () => {
  const backups = parseBackups(BACKUPS_JSON);
  const picked = newestCompletedBackup(backups, "tandoor", "seaweedfs");
  assert.equal(picked?.name, "velero-offsite-data-20261024040009");
  assert.equal(newestCompletedBackup(backups, "tandoor", "backblaze")?.name, "velero-offsite-data-20261024040500");
  assert.equal(newestCompletedBackup(backups, "immich", "seaweedfs"), undefined);
});

test("velero.ts: parses PodVolumeBackups into a plan, and restore status / scratch counts", () => {
  const plan = parsePodVolumeBackups(
    JSON.stringify({ items: [{ spec: { pod: { name: "tandoor-0" }, volume: "data" } }, { spec: { pod: { name: "tandoor-0" }, volume: "media" } }] }),
  );
  assert.deepEqual(plan.pods, ["tandoor-0"]);
  assert.equal(plan.volumes.length, 2);

  assert.equal(parseRestoreStatus(JSON.stringify({ status: { phase: "InProgress" } })).phase, "InProgress");
  assert.ok(!restoreIsDone(parseRestoreStatus(JSON.stringify({ status: { phase: "InProgress" } }))));
  assert.ok(restoreIsDone(parseRestoreStatus(JSON.stringify({ status: { phase: "Completed" } }))));

  const counts = parseScratchCounts(
    JSON.stringify({
      items: [
        { kind: "Pod" },
        { kind: "PersistentVolumeClaim", status: { phase: "Bound" } },
        { kind: "PersistentVolumeClaim", status: { phase: "Pending" } },
      ],
    }),
  );
  assert.deepEqual(counts, { pods: 1, pvcs: 2, pvcsBound: 1 });
});

test("velero.ts: argv builders validate their inputs and never target outside the scratch namespace", () => {
  assert.deepEqual(backupsListArgv().argv.slice(0, 2), ["get", "backups.velero.io"]);
  assert.deepEqual(podVolumeBackupsArgv("velero-offsite-data-20261024040009").argv.slice(0, 2), ["get", "podvolumebackups.velero.io"]);
  assert.throws(() => podVolumeBackupsArgv("x; rm -rf /"), /Invalid backup name/);
  assert.throws(() => restoreGetArgv("x$(id)"), /Invalid restore name/);

  const scratch = scratchNamespace("tandoor", 42);
  assert.equal(scratch, "velero-drill-tandoor-42");
  assert.equal(assertScratch(scratch), scratch);
  assert.throws(() => assertScratch("tandoor"), /not a .*scratch namespace/);
  assert.throws(() => scratchPodsAndPvcsArgv("tandoor"), /not a .*scratch namespace/);
  assert.throws(() => scratchNamespaceDeleteArgv("tandoor"), /not a .*scratch namespace/);
  assert.throws(
    () => restoreCreateArgv({ restoreName: scratch, backupName: "b", sourceNamespace: "tandoor", scratch: "tandoor" }),
    /not a .*scratch namespace/,
  );

  const create = restoreCreateArgv({ restoreName: scratch, backupName: "velero-offsite-data-20261024040009", sourceNamespace: "tandoor", scratch });
  assert.deepEqual(create.argv, [
    "restore",
    "create",
    scratch,
    "-n",
    "velero",
    "--from-backup",
    "velero-offsite-data-20261024040009",
    "--include-namespaces",
    "tandoor",
    "--namespace-mappings",
    `tandoor:${scratch}`,
  ]);
});

// ------------------------------------------------------------------ fake kubectl / velero binaries

async function fakeBinaries(dir: string) {
  const kubectl = join(dir, "fake-kubectl.cjs");
  const velero = join(dir, "fake-velero.cjs");
  await writeFile(
    kubectl,
    `#!/usr/bin/env node
const fs = require("fs");
const dir = process.env.FAKE_STATE_DIR;
const a = process.argv.slice(2);
const send = (text) => process.stdout.write(text);
if (a[0] === "get" && a[1] === "backups.velero.io") send(fs.readFileSync(dir + "/backups.json", "utf8"));
else if (a[0] === "get" && a[1] === "podvolumebackups.velero.io") send(fs.readFileSync(dir + "/pvbs.json", "utf8"));
else if (a[0] === "get" && a[1] === "restores.velero.io") {
  const completesAt = Number(fs.readFileSync(dir + "/completes_at", "utf8"));
  const done = Date.now() >= completesAt;
  send(JSON.stringify({ status: { phase: done ? "Completed" : "InProgress", warnings: 0, errors: 0 } }));
} else if (a[0] === "get" && a[1] === "pods,pvc") send(fs.readFileSync(dir + "/scratch.json", "utf8"));
else if (a[0] === "delete" && a[1] === "namespace") {
  fs.writeFileSync(dir + "/deleted-" + a[2], "1");
  send('namespace "' + a[2] + '" deleted\\n');
} else {
  process.stderr.write("fake-kubectl: unhandled argv " + JSON.stringify(a) + "\\n");
  process.exit(1);
}
`,
  );
  await writeFile(
    velero,
    `#!/usr/bin/env node
const fs = require("fs");
const dir = process.env.FAKE_STATE_DIR;
const a = process.argv.slice(2);
if (a[0] === "restore" && a[1] === "create") {
  fs.writeFileSync(dir + "/completes_at", String(Date.now() + 2500));
  process.stdout.write('Restore request "' + a[2] + '" submitted successfully.\\n');
} else {
  process.stderr.write("fake-velero: unhandled argv " + JSON.stringify(a) + "\\n");
  process.exit(1);
}
`,
  );
  await chmod(kubectl, 0o755);
  await chmod(velero, 0o755);
  return { kubectl, velero };
}

test("SIGKILL mid-restore resumes the velero-restore-drill job from its checkpoint with no client attached", async () => {
  const t = await tempStore();
  const fakeDir = await mkdtemp(join(tmpdir(), "dpi-fake-velero-"));
  const token = newToken();
  try {
    await writeFile(join(fakeDir, "backups.json"), BACKUPS_JSON);
    await writeFile(
      join(fakeDir, "pvbs.json"),
      JSON.stringify({ items: [{ spec: { pod: { name: "tandoor-0" }, volume: "data" } }, { spec: { pod: { name: "tandoor-0" }, volume: "media" } }] }),
    );
    await writeFile(
      join(fakeDir, "scratch.json"),
      JSON.stringify({
        items: [{ kind: "Pod" }, { kind: "PersistentVolumeClaim", status: { phase: "Bound" } }, { kind: "PersistentVolumeClaim", status: { phase: "Bound" } }],
      }),
    );
    const { kubectl, velero } = await fakeBinaries(fakeDir);

    const server = await bootServer({
      home: join(t.root, "home"),
      startDirs: t.work,
      token,
      env: { KUBECTL_BIN: kubectl, VELERO_BIN: velero, VELERO_NAMESPACE: "velero", FAKE_STATE_DIR: fakeDir },
    });
    try {
      const client = new DpiClient(server.base, token);
      const s = await client.createSession({ name: "Velero drill", cwd: t.work, model: faux });
      const main = client.agent(s.id, "main");
      const { taskId } = await main.demo<{ taskId: number }>("jobs", { job: "velero-restore-drill", input: { namespace: "tandoor", location: "seaweedfs" } });
      const runs = async () => (await main.doc<JobRunsDoc>("demo.job-runs")).value.items;
      const run = async () => (await runs())[taskId];

      // 1. Approve the restore.
      await until(async () => (await run())?.approval === "pending", 15000, "restore approval pending");
      await client.request("POST", `/v1/sessions/${s.id}/agents/main/demo/jobs/${taskId}/approval`, { approved: true });

      // 2. Kill mid-restore, while verify is still polling the fake Restore (completes ~2.5s after create).
      await until(async () => (await run())?.phase === "verify", 15000, "verify phase reached");
      await server.stop("SIGKILL");
      await server.start();

      // 3. After the restart, verify finishes and asks to approve cleanup.
      await until(async () => (await run())?.approval === "pending", 20000, "cleanup approval pending");
      assert.equal((await run()).phase, "cleanup-approve");
      await client.request("POST", `/v1/sessions/${s.id}/agents/main/demo/jobs/${taskId}/approval`, { approved: true });

      // 4. Cleanup runs once; the run completes.
      await until(async () => (await run())?.status === "completed", 15000, "run completed");
      const done = await run();
      assert.deepEqual(done.phases.map((p) => p.status), ["done", "done", "done", "done", "done", "done", "done"]);
      const scratch = `velero-drill-tandoor-${taskId}`;
      assert.equal(await readFile(join(fakeDir, `deleted-${scratch}`), "utf8"), "1");
      const history = await main.entries({ scope: "all" });
      assert.equal(history.items.filter((e) => e.kind === "demo.job").length, 1);
    } finally {
      await server.stop();
    }
  } finally {
    await t.cleanup();
    await rm(fakeDir, { recursive: true, force: true });
  }
});
