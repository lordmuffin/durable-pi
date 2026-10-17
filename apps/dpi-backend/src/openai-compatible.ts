// An OpenAI-compatible endpoint (LiteLLM, vLLM, Ollama) as the device's only provider (DPI_PROVIDER=openai-compatible).
//   OPENAI_BASE_URL     e.g. http://litellm-proxy-service.open-webui.svc.cluster.local:4000/v1 (required)
//   OPENAI_API_KEY      sent as the bearer key; keyless proxies take any placeholder (required by pi-ai auth)
//   DPI_MODELS          comma-separated model names exactly as the endpoint serves them (required)
//   DPI_DEFAULT_MODEL   default for new sessions and unknown model refs (default: first of DPI_MODELS)
//   DPI_CONTEXT_WINDOW  context window of every listed model (default 32768)
//   DPI_MAX_TOKENS      max output tokens of every listed model (default 8192)
import { createProvider, envApiKeyAuth, type Model, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const OPENAI_COMPATIBLE = "openai-compatible";

export interface OpenAICompatibleConfig {
  baseUrl: string;
  models: string[];
  defaultModel: string;
  contextWindow: number;
  maxTokens: number;
}

export function openAICompatibleConfig(env: NodeJS.ProcessEnv = process.env): OpenAICompatibleConfig {
  const baseUrl = (env.OPENAI_BASE_URL ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) throw Error("DPI_PROVIDER=openai-compatible needs OPENAI_BASE_URL (http[s]://…)");
  const models = [...new Set((env.DPI_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean))];
  if (!models.length) throw Error("DPI_PROVIDER=openai-compatible needs DPI_MODELS (comma-separated model names)");
  const defaultModel = env.DPI_DEFAULT_MODEL?.trim() || models[0];
  if (!models.includes(defaultModel)) throw Error(`DPI_DEFAULT_MODEL ${defaultModel} is not in DPI_MODELS`);
  const int = (key: string, fallback: number) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isInteger(n) || n < 1) throw Error(`Invalid ${key}: ${env[key]}`);
    return n;
  };
  return {
    baseUrl,
    models,
    defaultModel,
    contextWindow: int("DPI_CONTEXT_WINDOW", 32768),
    maxTokens: int("DPI_MAX_TOKENS", 8192),
  };
}

export function openAICompatibleProvider(config: OpenAICompatibleConfig): Provider<"openai-completions"> {
  const models: Model<"openai-completions">[] = config.models.map((id) => ({
    id,
    name: id,
    api: "openai-completions",
    provider: OPENAI_COMPATIBLE,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // vLLM behind LiteLLM: plain chat/completions, no OpenAI-only request fields.
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      maxTokensField: "max_tokens",
      supportsStrictMode: false,
    },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
  }));
  return createProvider({
    id: OPENAI_COMPATIBLE,
    name: "OpenAI-compatible",
    baseUrl: config.baseUrl,
    auth: { apiKey: envApiKeyAuth("OpenAI-compatible API key", ["OPENAI_API_KEY"]) },
    models,
    api: openAICompletionsApi(),
  });
}
