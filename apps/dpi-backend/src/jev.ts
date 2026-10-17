// Minimal Jev client (TypeSafe System One), from harness/extensions/jev-bash/core/client.ts: one call answers a few
// bounded questions about a JSON state in a few hundred milliseconds.
export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> };
export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> };

const RETRY = new Set([429, 502, 503, 529]);

export async function askJev(
  state: unknown,
  questions: Record<string, JevQuestion>,
  signal?: AbortSignal,
): Promise<Record<string, JevAnswer>> {
  if (process.env.JEV_BASE_URL) return askJevChat(process.env.JEV_BASE_URL, state, questions, signal);
  const [endpoint, key, model] = process.env.TYPESAFE_API_KEY
    ? ["https://api.typesafe.ai/v1/systemone", process.env.TYPESAFE_API_KEY, "jev-latest"]
    : process.env.OPENROUTER_API_KEY
      ? ["https://openrouter.ai/api/alpha/decisions", process.env.OPENROUTER_API_KEY, "~typesafe/jev-latest"]
      : [];
  if (!endpoint) throw Error("Jev needs TYPESAFE_API_KEY or OPENROUTER_API_KEY");
  const body = JSON.stringify({ model, state, questions });
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (RETRY.has(res.status) && attempt < 3) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw Error(`Jev HTTP ${res.status}`);
    const data = (await res.json()) as { answers?: Record<string, JevAnswer> };
    for (const [id, q] of Object.entries(questions))
      if (data.answers?.[id]?.type !== q.type) throw Error(`Jev answer missing: ${id}`);
    return data.answers!;
  }
}

// ------------------------------------------------------------------ a local Jev behind an OpenAI-compatible proxy
//   JEV_BASE_URL   e.g. http://litellm-proxy-service.open-webui.svc.cluster.local:4000/v1 (turns this path on)
//   JEV_MODEL      the proxy's model name (default jev)
//   JEV_API_KEY    bearer key (default OPENAI_API_KEY; keyless proxies take any placeholder)
// A small instruct model at temperature 0 answers the same bounded questions as JSON. Anything malformed throws,
// so a caller that fails closed blocks instead of guessing.

const clamp01 = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : undefined);

export function jevPrompt(questions: Record<string, JevQuestion>) {
  const lines = Object.entries(questions).map(([id, q]) =>
    q.type === "choice"
      ? `- "${id}": ${q.instructions} Answer {"choice": one of ${Object.keys(q.criteria).map((k) => JSON.stringify(k)).join(", ")}, "confidence": 0..1}. Criteria: ${Object.entries(q.criteria).map(([k, v]) => `${k} = ${v}`).join("; ")}`
      : `- "${id}": ${q.instructions} Answer {"noul": 0..1}, the probability the answer is true.${q.criteria ? ` true = ${q.criteria.true ?? ""}; false = ${q.criteria.false ?? ""}` : ""}`,
  );
  return [
    "You judge a JSON state and answer bounded questions. Reply with one JSON object only, keyed by question id.",
    ...lines,
  ].join("\n");
}

export function parseJevAnswers(text: string, questions: Record<string, JevQuestion>): Record<string, JevAnswer> {
  const raw = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as Record<string, Record<string, unknown>>;
  const out: Record<string, JevAnswer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = raw?.[id];
    if (q.type === "choice") {
      const choice = a?.choice;
      const confidence = clamp01(a?.confidence);
      if (typeof choice !== "string" || !(choice in q.criteria) || confidence === undefined)
        throw Error(`Jev answer missing: ${id}`);
      out[id] = { type: "choice", choice, confidence, probabilities: { [choice]: confidence } };
    } else {
      const noul = clamp01(a?.noul);
      if (noul === undefined) throw Error(`Jev answer missing: ${id}`);
      out[id] = { type: "noul", noul };
    }
  }
  return out;
}

async function askJevChat(
  baseUrl: string,
  state: unknown,
  questions: Record<string, JevQuestion>,
  signal?: AbortSignal,
): Promise<Record<string, JevAnswer>> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.JEV_API_KEY ?? process.env.OPENAI_API_KEY ?? "none"}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.JEV_MODEL ?? "jev",
      temperature: 0,
      max_tokens: 256,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: jevPrompt(questions) },
        { role: "user", content: JSON.stringify(state) },
      ],
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!res.ok) throw Error(`Jev HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return parseJevAnswers(data.choices?.[0]?.message?.content ?? "", questions);
}
