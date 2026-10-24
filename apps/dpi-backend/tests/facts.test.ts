// Facts: the fixed /facts schema, Store#writeFact (the only writer), the homelab-facts prompt
// section and staleness, and that agents cannot reach /facts through update_state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FACT_KEYS, isFactsPath, renderFacts } from "../src/facts.js";
import { createIncident } from "../src/incident.js";
import { tempStore } from "./helpers.js";

test("writeFact creates then updates a known key, rejects an unknown one and a wrong-typed value", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    const created = await store.writeFact("jevAvailable", true, "pi-durable-facts tick");
    assert.equal(created.ok, true);
    assert.equal(created.value, true);
    assert.deepEqual(Object.keys(((await store.deviceDoc("app.shared-state")).value as { facts: object }).facts), ["jevAvailable"]);

    await store.writeFact("jevAvailable", false, "pi-durable-facts tick");
    assert.equal(((await store.deviceDoc("app.shared-state")).value as { facts: { jevAvailable: { value: boolean } } }).facts.jevAvailable.value, false);

    await assert.rejects(() => store.writeFact("notARealFact", "x", "test"), /Unknown fact/);
    await assert.rejects(() => store.writeFact("jevAvailable", "not a boolean", "test"), /must be a boolean/);
    await assert.rejects(() => store.writeFact("openJevPrs", "3", "test"), /must be a finite number/);
    await assert.rejects(() => store.writeFact("lastDigestDate", "x".repeat(201), "test"), /up to 200 characters/);
    await assert.rejects(() => store.writeFact("jevAvailable", true, ""), /source must be/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("writeFact honors expectedRevision and surfaces a stale one as a conflict", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    await store.writeFact("jevAvailable", true, "tick");
    const stale = (await store.shared.snapshot()).revision;
    await store.writeFact("jevAvailable", false, "tick");
    await assert.rejects(() => store.writeFact("jevAvailable", true, "tick", stale), /App State changed/);
  } finally {
    await store.close();
    await t.cleanup();
  }
});

test("isFactsPath — the predicate update_state (the agent tool) uses to refuse /facts writes", () => {
  assert.ok(isFactsPath("/facts"));
  assert.ok(isFactsPath("/facts/jevAvailable"));
  assert.ok(isFactsPath("/facts/activeGpuProfile.andrew-gamingpc"));
  assert.ok(!isFactsPath("/facts-unrelated"));
  assert.ok(!isFactsPath("/custom/facts"));
  assert.ok(!isFactsPath("/"));
});

test("renderFacts lists every known key, in schema order, under 40 lines, marking stale entries", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  const fresh = new Date(now - 60_000).toISOString();
  const old = new Date(now - 48 * 3_600_000).toISOString();
  const state = {
    facts: {
      jevAvailable: { value: true, updatedAt: fresh, source: "pi-durable-facts tick" },
      lastDigestDate: { value: "2026-10-22", updatedAt: old, source: "nightly digest job" },
    },
  };
  const text = renderFacts(state, now);
  const lines = text.split("\n");
  assert.ok(lines.length < 40);
  assert.equal(lines.length, FACT_KEYS.length + 1);
  assert.ok(lines[0].startsWith("Homelab facts"));
  assert.ok(lines.some((l) => l.includes("jevAvailable: true") && !l.includes("STALE")));
  assert.ok(lines.some((l) => l.includes("lastDigestDate") && l.includes("STALE")));
  assert.ok(lines.some((l) => l.includes("activeGpuProfile.andrew-gamingpc: unknown (never written)")));
});

test("homelab-incident puts the facts section first, ahead of the incident prompt", async () => {
  const t = await tempStore();
  const store = await t.open();
  try {
    await store.writeFact("jevAvailable", true, "tick");
    const incident = createIncident(store.shared, "sess-1");
    assert.equal(incident.sections?.[0]?.key, "homelab-facts");
    const rendered = await (incident.sections![0]!.render as unknown as () => Promise<string>)();
    assert.ok(String(rendered).includes("jevAvailable: true"));
  } finally {
    await store.close();
    await t.cleanup();
  }
});
