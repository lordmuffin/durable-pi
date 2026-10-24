// Shared facts: a fixed, small set of App State keys under /facts that every agent can read at
// session start, kept current by homelab automation (CI workflows, cron jobs) rather than agents.
// Writing is deliberately not an agent tool — see store.ts#writeFact and routes.ts POST /v1/facts/:key,
// the only way to change a fact. Agents read facts through the existing read_state tool / GET
// /v1/docs/app.shared-state, same as any other App State path.
//
// This schema is pinned as JSON in the homelab repo (docs/pi-durable.md "Facts" table, checked by
// tests/tdd/test_pi_durable_facts.py) — keep FACT_SCHEMA and that pin in sync when either changes.
import type { JsonValue } from "../../dpi-sdk/src/app-state.js";

export type FactValue = string | number | boolean;

export interface FactEntry {
  value: FactValue;
  updatedAt: string; // ISO 8601
  source: string; // short label: which workflow/job owns this fact
}

export interface FactDef {
  key: string;
  type: "string" | "number" | "boolean";
  owner: string; // documentary: who writes this key
  staleAfterMs: number;
}

const HOUR = 3_600_000;

/** The fixed set of facts. Adding a key here, the REST route and the homelab docs pin are all required together. */
export const FACT_SCHEMA: readonly FactDef[] = [
  { key: "activeGpuProfile.andrew-gamingpc", type: "string", owner: "deploy-k3s-andrew-gamingpc.yml", staleAfterMs: 24 * HOUR },
  { key: "activeGpuProfile.lxc-k3s2-gpu-a", type: "string", owner: "deploy-k3s-lxc-k3s2-gpu-a.yml", staleAfterMs: 24 * HOUR },
  { key: "lastVeleroBackupTime", type: "string", owner: "velero restore-drill job", staleAfterMs: 26 * HOUR },
  { key: "lastVeleroBackupPhase", type: "string", owner: "velero restore-drill job", staleAfterMs: 26 * HOUR },
  { key: "lastDigestDate", type: "string", owner: "nightly digest job", staleAfterMs: 26 * HOUR },
  { key: "lastDigestNeededPerson", type: "boolean", owner: "nightly digest job", staleAfterMs: 26 * HOUR },
  { key: "openJevPrs", type: "number", owner: "pi-durable-facts tick", staleAfterMs: 2 * HOUR },
  { key: "jevAvailable", type: "boolean", owner: "pi-durable-facts tick", staleAfterMs: 2 * HOUR },
] as const;

export const FACT_KEYS: readonly string[] = FACT_SCHEMA.map((f) => f.key);
const FACT_BY_KEY = new Map(FACT_SCHEMA.map((f) => [f.key, f]));

export function factDef(key: string): FactDef {
  const def = FACT_BY_KEY.get(key);
  if (!def) throw Error(`Unknown fact ${key}. Known: ${FACT_KEYS.join(", ")}`);
  return def;
}

/** Validates a value against a fact's declared type and a short-string cap, well under the App State cap. */
export function checkFactValue(def: FactDef, value: unknown): FactValue {
  if (def.type === "string") {
    if (typeof value !== "string" || value.length > 200) throw Error(`${def.key} must be a string up to 200 characters`);
    return value;
  }
  if (def.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) throw Error(`${def.key} must be a finite number`);
    return value;
  }
  if (typeof value !== "boolean") throw Error(`${def.key} must be a boolean`);
  return value;
}

/** True for "/facts" and any path under it — the paths update_state (the agent tool) must refuse. */
export function isFactsPath(path: string): boolean {
  return path === "/facts" || path.startsWith("/facts/");
}

export function checkFactSource(source: unknown): string {
  if (typeof source !== "string" || !source.trim() || source.length > 100) throw Error("source must be a non-empty string up to 100 characters");
  return source;
}

type FactsState = Record<string, FactEntry | undefined>;

/** Renders every known fact for the top of a prompt, marking any older than its own staleness threshold. Stays well under 40 lines. */
export function renderFacts(state: Record<string, JsonValue>, now = Date.now()): string {
  const facts = (state.facts ?? {}) as unknown as FactsState;
  const lines = ["Homelab facts (App State /facts, written by automation — read only):"];
  for (const def of FACT_SCHEMA) {
    const entry = facts[def.key];
    if (!entry) {
      lines.push(`- ${def.key}: unknown (never written)`);
      continue;
    }
    const age = now - Date.parse(entry.updatedAt);
    const stale = !Number.isFinite(age) || age > def.staleAfterMs ? " [STALE]" : "";
    lines.push(`- ${def.key}: ${JSON.stringify(entry.value)} (${entry.updatedAt} via ${entry.source})${stale}`);
  }
  return lines.join("\n");
}
