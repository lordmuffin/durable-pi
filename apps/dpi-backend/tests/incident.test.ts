// homelab-incident and Jev's incident memory (homelab-gitops docs/jev.md §Incident memory), with fetch mocked.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIncident, formatPastIncidents, INCIDENT_PROMPT, MEMORY_PROMPT } from "../src/incident.js";
import { SharedState } from "../src/shared-state.js";
import type { GitopsConfig } from "../src/gitops.js";

const JEV = { url: "http://jev.test:8081", token: "dpi-tok" };
const SESSION = "s-0123456789";
const RCA_ARGS = {
  incident_id: "inc-1cf0a72e-20261023t1206",
  severity: "high",
  summary: "Flux cannot pull homelab-gitops",
  root_cause: "the git auth secret was renamed",
  evidence: ["flux get sources git: auth failed"],
  remediation: "point the GitRepository at the new secret",
};

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };

/** Replaces fetch for one test; `answer` decides each response. */
function mockFetch(t: TestContext, answer: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL, init: RequestInit = {}) => {
    const c: Call = {
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(c);
    assert.ok(init.signal instanceof AbortSignal, "every call has a timeout signal");
    return answer(c);
  });
  return calls;
}
const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

async function setup(t: TestContext, opts: { gitops?: GitopsConfig; jev?: typeof JEV } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "dpi-incident-"));
  const shared = await SharedState.open(join(dir, "shared.sqlite"));
  t.after(async () => {
    await shared.close();
    await rm(dir, { recursive: true, force: true });
  });
  const ext = createIncident(shared, SESSION, opts.gitops, opts.jev);
  const tool = (name: string) => {
    const found = ext.tools?.find((x) => x.name === name);
    assert.ok(found, name);
    return found;
  };
  const counters: Record<string, { count: number }> = {};
  const api = {
    taskId: 7,
    conversationId: "c1",
    output: () => {},
    commit: async (fn: (tx: unknown) => Promise<void>) =>
      fn({ doc: async (d: { kind: string }) => (counters[d.kind] ??= { count: 0 }) }),
  };
  const run = async (name: string, args: unknown) => {
    api.taskId++; // a new tool call; the same taskId would be a replay, which save_rca's receipts skip
    const r = await (tool(name).execute as any)(args, api, {});
    return r.content[0].text as string;
  };
  const prompt = async () => (await ext.sections![0].render({} as never, {} as never)) ?? "";
  return { shared, ext, run, prompt };
}

const savedRca = async (shared: SharedState) =>
  ((await shared.snapshot()).value as { incidents?: Record<string, any> }).incidents?.[RCA_ARGS.incident_id];

test("save_rca POSTs the App State RCA to Jev with the bearer", async (t) => {
  let status = 201;
  const calls = mockFetch(t, () => json(status, { incident: {} }));
  const f = await setup(t, { jev: JEV });
  const text = await f.run("save_rca", { ...RCA_ARGS, tags: ["flux", "git"] });
  assert.equal(text, `Saved the RCA to App State /incidents/${RCA_ARGS.incident_id}.`);
  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.equal(c.method, "POST");
  assert.equal(c.url, `${JEV.url}/incidents/${RCA_ARGS.incident_id}/rca`);
  assert.equal(c.headers.authorization, "Bearer dpi-tok");
  assert.equal(c.headers["content-type"], "application/json");
  const stored = await savedRca(f.shared);
  assert.deepEqual(c.body, { session_id: SESSION, rca: stored, tags: ["flux", "git"] });
  assert.equal(stored.tags, undefined, "tags go to Jev only");
  // Without tags Jev gets an empty list; an update (200) is fine too.
  status = 200;
  assert.equal(await f.run("save_rca", RCA_ARGS), `Saved the RCA to App State /incidents/${RCA_ARGS.incident_id}.`);
  assert.deepEqual(calls[1].body.tags, []);
});

test("save_rca still saves App State when Jev answers 500 or the fetch throws", async (t) => {
  let mode: "500" | "throw" = "500";
  mockFetch(t, () => {
    if (mode === "throw") throw new TypeError("fetch failed");
    return new Response("boom", { status: 500 });
  });
  const f = await setup(t, { jev: JEV });
  const text = await f.run("save_rca", RCA_ARGS);
  assert.match(text, /^Saved the RCA to App State \/incidents\/inc-1cf0a72e-20261023t1206\. Jev's incident memory did not take it: Jev HTTP 500 boom\.$/);
  assert.equal((await savedRca(f.shared)).summary, RCA_ARGS.summary);

  mode = "throw";
  const text2 = await f.run("save_rca", { ...RCA_ARGS, summary: "second" });
  assert.match(text2, /Jev's incident memory did not take it: fetch failed\.$/);
  assert.equal((await savedRca(f.shared)).summary, "second");
});

test("propose_fix sends Jev the PR link and notes a 422 without failing", async (t) => {
  const gitops: GitopsConfig = { api: "http://forgejo.test/api/v1", repo: "o/r", token: "tok", base: "main", maxOpen: 5 };
  const prUrl = "http://forgejo.test/o/r/pulls/700";
  let jevStatus = 200;
  const calls = mockFetch(t, (c) => {
    if (c.url.startsWith(JEV.url)) return json(jevStatus, jevStatus === 200 ? {} : { detail: "no RCA stored yet" });
    const path = new URL(c.url).pathname.replace("/api/v1/repos/o/r", "");
    if (c.method === "GET" && path.startsWith("/contents/"))
      return json(200, { type: "file", path: "apps/x/a.yaml", name: "a.yaml", sha: "s1", content: Buffer.from("tag: v1\n").toString("base64") });
    if (c.method === "GET" && path === "/pulls") return json(200, []);
    if (c.method === "POST" && path === "/pulls") return json(201, { number: 700, html_url: prUrl, head: { ref: c.body.head } });
    return json(201, {});
  });
  const f = await setup(t, { gitops, jev: JEV });
  const args = { incident_id: RCA_ARGS.incident_id, title: "Bump tag", rationale: "r", edits: [{ path: "apps/x/a.yaml", old_string: "tag: v1", new_string: "tag: v2" }] };
  const text = await f.run("propose_fix", args);
  assert.match(text, /^Opened PR #700 from jev\/inc-1cf0a72e-20261023t1206: http:\/\/forgejo\.test\/o\/r\/pulls\/700\./);
  const jevCalls = calls.filter((c) => c.url.startsWith(JEV.url));
  assert.equal(jevCalls.length, 1);
  assert.equal(jevCalls[0].method, "POST");
  assert.equal(jevCalls[0].url, `${JEV.url}/incidents/${RCA_ARGS.incident_id}/rca`);
  assert.equal(jevCalls[0].headers.authorization, "Bearer dpi-tok");
  assert.deepEqual(jevCalls[0].body, { pr_url: prUrl });
  assert.doesNotMatch(text, /Jev/);

  jevStatus = 422;
  const text2 = await f.run("propose_fix", { ...args, incident_id: "inc-99999999-20261023t1300" });
  assert.match(text2, /^Opened PR #700.* Jev's incident memory did not take the PR link: Jev HTTP 422 .*no RCA stored yet.*\.$/);
});

test("search_past_incidents builds the query, formats results and says when there are none", async (t) => {
  const hit = {
    incident_id: "inc-aaaaaaaa-20261001t0900",
    alert_key: "k",
    session_id: "s-1",
    rca: { severity: "high", summary: "OOMKilled jev-llm-cpu", root_cause: "x".repeat(450), remediation: "raise the memory limit" },
    tags: ["oom", "jev"],
    pr_url: "https://git.apj.dev/o/r/pulls/12",
    created_at: "2026-10-01T09:00:00Z",
    resolved_at: null,
    alertname: "KubePodCrashLooping",
    namespace: "jev",
    score: 0.71,
  };
  let incidents: unknown[] = [hit];
  let down = false;
  const calls = mockFetch(t, () => (down ? new Response("down", { status: 503 }) : json(200, { incidents })));
  const f = await setup(t, { jev: JEV });
  const text = await f.run("search_past_incidents", { alertname: "KubePodCrashLooping", namespace: "jev", query: "OOMKilled after restart" });
  const u = new URL(calls[0].url);
  assert.equal(calls[0].method, "GET");
  assert.equal(`${u.origin}${u.pathname}`, `${JEV.url}/incidents/search`);
  assert.deepEqual([...u.searchParams], [["alertname", "KubePodCrashLooping"], ["namespace", "jev"], ["q", "OOMKilled after restart"]]);
  assert.equal(calls[0].headers.authorization, "Bearer dpi-tok");
  const lines = text.split("\n");
  assert.equal(lines[0], "inc-aaaaaaaa-20261001t0900 (KubePodCrashLooping/jev) 2026-10-01T09:00:00Z → unresolved, score 0.71, tags oom, jev");
  assert.equal(lines[1], "summary: OOMKilled jev-llm-cpu");
  assert.equal(lines[2], `root cause: ${"x".repeat(399)}…`);
  assert.equal(lines[3], "remediation: raise the memory limit");
  assert.equal(lines[4], "PR: https://git.apj.dev/o/r/pulls/12");

  // Empty parameters are left out; no q means no score.
  incidents = [];
  assert.equal(await f.run("search_past_incidents", { namespace: "", query: "  ", alertname: "FluxReconcileFailing" }), "No similar past incidents.");
  assert.equal(calls[1].url, `${JEV.url}/incidents/search?alertname=FluxReconcileFailing`);
  await f.run("search_past_incidents", {});
  assert.equal(calls[2].url, `${JEV.url}/incidents/search`);
  assert.equal(
    formatPastIncidents([{ ...hit, score: undefined, tags: [], pr_url: null, resolved_at: "2026-10-01T10:00:00Z" }]).split("\n")[0],
    "inc-aaaaaaaa-20261001t0900 (KubePodCrashLooping/jev) 2026-10-01T09:00:00Z → 2026-10-01T10:00:00Z, tags none",
  );

  // A failure throws (read-only, so a retry is safe).
  down = true;
  await assert.rejects(f.run("search_past_incidents", { alertname: "X" }), /search_past_incidents: Jev's incident memory is unavailable \(Jev HTTP 503 down\)/);
});

test("the prompt asks for search first only when Jev is configured", async (t) => {
  mockFetch(t, () => json(201, {}));
  const f = await setup(t, { jev: JEV });
  assert.ok(f.ext.tools?.some((x) => x.name === "search_past_incidents" && x.replay === "safe"));
  assert.equal(await f.prompt(), `${INCIDENT_PROMPT}\n\n${MEMORY_PROMPT}`);
});

test("with JEV_API_URL unset: no search tool, no tags, no prompt change, no fetch", async (t) => {
  const saved = process.env.JEV_API_URL;
  delete process.env.JEV_API_URL;
  t.after(() => {
    if (saved !== undefined) process.env.JEV_API_URL = saved;
  });
  const calls = mockFetch(t, () => json(201, {}));
  const f = await setup(t);
  assert.deepEqual(f.ext.tools?.map((x) => x.name), ["k8s_read", "save_rca", "notify"]);
  const params = f.ext.tools?.find((x) => x.name === "save_rca")?.parameters as { properties: Record<string, unknown> };
  assert.ok(!("tags" in params.properties));
  assert.equal(await f.prompt(), INCIDENT_PROMPT);
  assert.equal(await f.run("save_rca", RCA_ARGS), `Saved the RCA to App State /incidents/${RCA_ARGS.incident_id}.`);
  assert.equal(calls.length, 0);
});
