#!/usr/bin/env node
// A fake kubectl for homelab-digest.test.ts: enough canned output per resource/verb for
// jobs.ts's checkVelero/checkCnpg/checkB2/checkFlux/checkPods to parse, no real cluster needed.
const argv = process.argv.slice(2);
const verb = argv[0];
const resource = argv[1];

const list = (items) => JSON.stringify({ items });

if (verb === "logs") {
  const mode = process.env.FAKE_B2_MODE ?? "ok";
  process.stdout.write(mode === "stale" ? "STALE: newest object is 11.0 days old\n" : "Backblaze backup OK: newest object 2.1 days old\n");
  process.exit(0);
}

if (resource === "backups.velero.io") {
  const now = new Date().toISOString();
  process.stdout.write(
    list([{ metadata: { name: "velero-daily-local-1", namespace: "velero" }, status: { phase: "Completed", startTimestamp: now } }]),
  );
  process.exit(0);
}

if (resource === "clusters.postgresql.cnpg.io") {
  process.stdout.write(
    list([
      {
        metadata: { name: "postgres-cluster", namespace: "postgres" },
        status: { conditions: [{ type: "ContinuousArchiving", status: "True" }, { type: "LastBackupSucceeded", status: "True" }] },
      },
    ]),
  );
  process.exit(0);
}

if (resource === "jobs") {
  process.stdout.write(list([{ metadata: { name: "b2-backup-monitor-1" }, status: { startTime: new Date().toISOString() } }]));
  process.exit(0);
}

if (resource === "pods" && argv.includes("-l")) {
  process.stdout.write(list([{ metadata: { name: "b2-backup-monitor-1-abcde" } }]));
  process.exit(0);
}

if (resource === "pods") {
  process.stdout.write(
    list([
      {
        metadata: { name: "ok-pod", namespace: "default" },
        status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }] },
      },
    ]),
  );
  process.exit(0);
}

if (resource === "kustomizations.kustomize.toolkit.fluxcd.io" || resource === "helmreleases.helm.toolkit.fluxcd.io") {
  process.stdout.write(
    list([{ metadata: { name: "flux-system", namespace: "flux-system" }, status: { conditions: [{ type: "Ready", status: "True" }] } }]),
  );
  process.exit(0);
}

process.stderr.write(`fake-kubectl: unexpected call ${JSON.stringify(argv)}\n`);
process.exit(1);
