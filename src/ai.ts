// AI settings and calls: Anthropic (Claude), OpenRouter, and Ollama on the
// local network. AI is never required; it's used only when a sort or
// automation's code asks, or when someone clicks an "Ask AI" button.
// Every call is logged, and a monthly spending cap can stop paid calls.
import Anthropic from '@anthropic-ai/sdk';
import { db, getSetting, setSetting } from './db.ts';
import { HttpError } from './sorts.ts';

export type Provider = 'anthropic' | 'openrouter' | 'ollama';
export const PROVIDERS: Provider[] = ['anthropic', 'openrouter', 'ollama'];
export type Feature = 'sort' | 'automation' | 'builder' | 'test';

export interface AiConfig {
  defaultProvider: Provider | '';
  anthropic: { apiKey: string; model: string };
  openrouter: { apiKey: string; model: string };
  ollama: { baseUrl: string; model: string };
  allow: { builder: boolean; sorts: boolean; automations: boolean };
  /** US dollars per calendar month for Anthropic + OpenRouter; 0 = no cap. */
  monthlyCapUsd: number;
}

const DEFAULTS: AiConfig = {
  defaultProvider: '',
  anthropic: { apiKey: '', model: 'claude-opus-5' },
  openrouter: { apiKey: '', model: '' },
  ollama: { baseUrl: '', model: '' },
  allow: { builder: true, sorts: true, automations: true },
  monthlyCapUsd: 0,
};

db.exec(`
CREATE TABLE IF NOT EXISTS ai_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  feature       TEXT NOT NULL,
  channel_id    TEXT,
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  ok            INTEGER NOT NULL,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS ai_usage_at ON ai_usage(at DESC);
`);

export function aiConfig(): AiConfig {
  const saved = getSetting<Partial<AiConfig>>('aiConfig', {});
  return {
    ...DEFAULTS, ...saved,
    anthropic: { ...DEFAULTS.anthropic, ...saved.anthropic },
    openrouter: { ...DEFAULTS.openrouter, ...saved.openrouter },
    ollama: { ...DEFAULTS.ollama, ...saved.ollama },
    allow: { ...DEFAULTS.allow, ...saved.allow },
  };
}

const hint = (key: string) => (key ? { apiKeySet: true, apiKeyHint: `…${key.slice(-4)}` } : { apiKeySet: false, apiKeyHint: '' });

/** What the browser sees: API keys are never sent back, only whether one is set. */
export function publicAiConfig() {
  const c = aiConfig();
  return {
    defaultProvider: c.defaultProvider,
    anthropic: { model: c.anthropic.model, ...hint(c.anthropic.apiKey) },
    openrouter: { model: c.openrouter.model, ...hint(c.openrouter.apiKey) },
    ollama: { baseUrl: c.ollama.baseUrl, model: c.ollama.model },
    allow: c.allow,
    monthlyCapUsd: c.monthlyCapUsd,
    configured: PROVIDERS.filter(p => isConfigured(c, p)),
    spentThisMonthUsd: spentThisMonth(),
  };
}

function isConfigured(c: AiConfig, p: Provider): boolean {
  if (p === 'anthropic') return !!c.anthropic.apiKey && !!c.anthropic.model;
  if (p === 'openrouter') return !!c.openrouter.apiKey && !!c.openrouter.model;
  return !!c.ollama.baseUrl && !!c.ollama.model;
}

/**
 * Saves AI settings. An API key left out (undefined) keeps the saved one;
 * an empty string removes it.
 */
export function saveAiConfig(input: any) {
  const c = aiConfig();
  const next: AiConfig = structuredClone(c);
  const str = (v: unknown, max = 500) => String(v ?? '').trim().slice(0, max);
  if (input.defaultProvider !== undefined) {
    const p = str(input.defaultProvider);
    if (p && !PROVIDERS.includes(p as Provider)) throw new HttpError(400, `Unknown provider "${p}".`);
    next.defaultProvider = p as Provider | '';
  }
  for (const p of ['anthropic', 'openrouter'] as const) {
    const v = input[p];
    if (!v) continue;
    if (v.apiKey !== undefined) next[p].apiKey = str(v.apiKey);
    if (v.model !== undefined) next[p].model = str(v.model, 200);
  }
  if (input.ollama) {
    if (input.ollama.baseUrl !== undefined) {
      const url = str(input.ollama.baseUrl).replace(/\/+$/, '').replace(/\/v1$/, '');
      if (url && !/^https?:\/\/[^\s]+$/.test(url)) throw new HttpError(400, 'The Ollama address must look like http://192.168.1.50:11434');
      next.ollama.baseUrl = url;
    }
    if (input.ollama.model !== undefined) next.ollama.model = str(input.ollama.model, 200);
  }
  if (input.allow) {
    for (const k of ['builder', 'sorts', 'automations'] as const) if (input.allow[k] !== undefined) next.allow[k] = !!input.allow[k];
  }
  if (input.monthlyCapUsd !== undefined) {
    const n = Number(input.monthlyCapUsd);
    if (!Number.isFinite(n) || n < 0 || n > 10_000) throw new HttpError(400, 'The monthly cap must be between 0 (no cap) and 10000 dollars.');
    next.monthlyCapUsd = n;
  }
  if (next.defaultProvider && !isConfigured(next, next.defaultProvider)) {
    throw new HttpError(400, `The default provider (${next.defaultProvider}) isn't fully set up yet.`);
  }
  setSetting('aiConfig', next);
  return publicAiConfig();
}

// ---------- spending ----------
const monthStart = (now = Date.now()) => { const d = new Date(now); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };

export function spentThisMonth(now = Date.now()): number {
  const row = db.prepare('SELECT coalesce(sum(cost_usd), 0) AS s FROM ai_usage WHERE at >= ?').get(monthStart(now)) as { s: number };
  return Math.round(row.s * 10000) / 10000;
}

// Anthropic prices, US dollars per million tokens (input, output).
const ANTHROPIC_PRICES: Record<string, [number, number]> = {
  'claude-fable-5-1': [10, 50], 'claude-fable-5': [10, 50], 'claude-opus-5-5': [4, 20], 'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25], 'claude-opus-4-7': [5, 25], 'claude-opus-4-6': [5, 25], 'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15], 'claude-haiku-4-5': [1, 5],
};

function logUsage(e: { feature: Feature; channelId?: string; provider: Provider; model: string; inputTokens?: number; outputTokens?: number; costUsd?: number | null; ok: boolean; error?: string }) {
  db.prepare(`INSERT INTO ai_usage (at, feature, channel_id, provider, model, input_tokens, output_tokens, cost_usd, ok, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(Date.now(), e.feature, e.channelId ?? null, e.provider, e.model, e.inputTokens ?? null, e.outputTokens ?? null,
      e.costUsd ?? null, e.ok ? 1 : 0, e.error ? e.error.slice(0, 500) : null);
  // Keep a year of usage.
  db.prepare('DELETE FROM ai_usage WHERE at < ?').run(Date.now() - 366 * 86_400_000);
}

export function listUsage(limit = 100) {
  return db.prepare(`SELECT id, at, feature, channel_id AS channelId, provider, model, input_tokens AS inputTokens,
      output_tokens AS outputTokens, cost_usd AS costUsd, ok, error FROM ai_usage ORDER BY at DESC, id DESC LIMIT ?`)
    .all(Math.min(Math.max(limit, 1), 1000));
}

// ---------- asking ----------
export interface AskOptions {
  prompt: string;
  system?: string;
  provider?: Provider;
  model?: string;
  maxTokens?: number;
  /** Who is asking, for the allow switches and the usage log. */
  feature: Feature;
  channelId?: string;
  /** Legacy ctx.utils.claude({ apiKey }): a sort's own Anthropic key. */
  apiKey?: string;
}

export interface AskResult { text: string; provider: Provider; model: string; inputTokens?: number; outputTokens?: number; costUsd?: number | null }

/** Whether AI can be used for this feature right now (set up and allowed). */
export function aiAvailable(feature: Feature): boolean {
  const c = aiConfig();
  const allowed = feature === 'test' || (feature === 'sort' ? c.allow.sorts : feature === 'automation' ? c.allow.automations : c.allow.builder);
  return allowed && !!c.defaultProvider && isConfigured(c, c.defaultProvider);
}

export async function ask(opts: AskOptions): Promise<AskResult> {
  const c = aiConfig();
  if (!opts.prompt || !String(opts.prompt).trim()) throw new Error('The AI needs a prompt.');
  const allowed = opts.feature === 'test' || (opts.feature === 'sort' ? c.allow.sorts : opts.feature === 'automation' ? c.allow.automations : c.allow.builder);
  if (!allowed) throw new Error(`AI is turned off for ${opts.feature === 'sort' ? 'sorts' : opts.feature === 'automation' ? 'automations' : 'the Channel Builder'} in Settings.`);

  let provider: Provider;
  let apiKey = '';
  if (opts.apiKey) {
    provider = 'anthropic';
    apiKey = opts.apiKey;
  } else {
    provider = (opts.provider || c.defaultProvider) as Provider;
    if (!provider) throw new Error('AI isn\'t set up. Add a provider under Settings → AI.');
    if (!PROVIDERS.includes(provider)) throw new Error(`Unknown AI provider "${provider}".`);
    if (!isConfigured(c, provider)) throw new Error(`The ${provider} provider isn't set up under Settings → AI.`);
    if (provider !== 'ollama') apiKey = c[provider].apiKey;
  }
  const model = String(opts.model || (provider === 'ollama' ? c.ollama.model : c[provider].model) || (provider === 'anthropic' ? 'claude-opus-5' : ''));
  if (!model) throw new Error(`No model chosen for ${provider}.`);

  if (provider !== 'ollama' && c.monthlyCapUsd > 0) {
    const spent = spentThisMonth();
    if (spent >= c.monthlyCapUsd) {
      const err = `This month's AI spending cap ($${c.monthlyCapUsd}) has been reached ($${spent.toFixed(2)} spent). Raise it under Settings → AI, or use Ollama.`;
      logUsage({ feature: opts.feature, channelId: opts.channelId, provider, model, ok: false, error: err });
      throw new Error(err);
    }
  }

  const maxTokens = Math.min(Math.max(Number(opts.maxTokens) || 4000, 16), 64000);
  try {
    const r = provider === 'anthropic'
      ? await callAnthropic(apiKey, model, String(opts.prompt), opts.system, maxTokens)
      : await callOpenAiCompatible(provider, provider === 'ollama' ? `${c.ollama.baseUrl}/v1` : 'https://openrouter.ai/api/v1', apiKey, model, String(opts.prompt), opts.system, maxTokens);
    logUsage({ feature: opts.feature, channelId: opts.channelId, provider, model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, ok: true });
    return { ...r, provider, model };
  } catch (err: any) {
    logUsage({ feature: opts.feature, channelId: opts.channelId, provider, model, ok: false, error: err?.message || String(err) });
    throw err;
  }
}

async function callAnthropic(apiKey: string, model: string, prompt: string, system: string | undefined, maxTokens: number) {
  const client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });
  const params: Record<string, unknown> = { model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
  if (system) params.system = system;
  // Opus 5 / Fable 5.1 can decline a request; let the API retry it on a
  // suitable fallback model instead of failing.
  const useFallbacks = /^claude-(opus-5|fable-5-1)$/.test(model);
  if (useFallbacks) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  try {
    const response: any = useFallbacks ? await client.beta.messages.create(params as any) : await client.messages.create(params as any);
    if (response.stop_reason === 'refusal') {
      throw new Error(`Claude declined the request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}.`);
    }
    const text = (response.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    const inputTokens = response.usage?.input_tokens ?? 0;
    const outputTokens = response.usage?.output_tokens ?? 0;
    const price = ANTHROPIC_PRICES[response.model] || ANTHROPIC_PRICES[model];
    const costUsd = price ? (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000 : null;
    return { text, inputTokens, outputTokens, costUsd };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key.');
    if (err instanceof Anthropic.RateLimitError) throw new Error('Anthropic: rate limited, try again shortly.');
    if (err instanceof Anthropic.APIError) throw new Error(`Anthropic error ${err.status ?? ''}: ${err.message}`);
    throw err;
  }
}

/** OpenRouter and Ollama both speak the OpenAI chat-completions format. */
async function callOpenAiCompatible(provider: Provider, baseUrl: string, apiKey: string, model: string, prompt: string, system: string | undefined, maxTokens: number) {
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: prompt }];
  const body: Record<string, unknown> = { model, messages, max_tokens: maxTokens, stream: false };
  if (provider === 'openrouter') body.usage = { include: true }; // asks OpenRouter to report the cost
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...(provider === 'openrouter' ? { 'X-Title': 'Schedule Lab' } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(provider === 'ollama' ? 300_000 : 120_000),
    });
  } catch (err: any) {
    throw new Error(`Can't reach ${provider === 'ollama' ? `Ollama at ${baseUrl.replace(/\/v1$/, '')}` : 'OpenRouter'}: ${err?.cause?.code || err?.message}`);
  }
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* reported below */ }
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || text.slice(0, 300);
    if (res.status === 401) throw new Error(`${provider === 'openrouter' ? 'OpenRouter' : 'Ollama'} rejected the API key.`);
    if (res.status === 404 && provider === 'ollama') throw new Error(`Ollama doesn't have the model "${model}" (run: ollama pull ${model}).`);
    throw new Error(`${provider === 'openrouter' ? 'OpenRouter' : 'Ollama'} error ${res.status}: ${msg}`);
  }
  const out = data?.choices?.[0]?.message?.content;
  if (typeof out !== 'string') throw new Error(`Unexpected answer from ${provider}.`);
  return {
    text: out,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
    costUsd: provider === 'ollama' ? 0 : (typeof data.usage?.cost === 'number' ? data.usage.cost : null),
  };
}

/** Sends a tiny request to one provider. */
export async function testProvider(provider: Provider) {
  const t0 = Date.now();
  const r = await ask({ prompt: 'Reply with the single word: OK', maxTokens: 512, feature: 'test', provider });
  return { ok: true, provider, model: r.model, reply: r.text.trim().slice(0, 200), ms: Date.now() - t0, costUsd: r.costUsd ?? null };
}

/** Models to choose from, for the settings form. */
export async function listModels(provider: Provider): Promise<string[]> {
  const c = aiConfig();
  if (provider === 'anthropic') return Object.keys(ANTHROPIC_PRICES);
  if (provider === 'ollama') {
    if (!c.ollama.baseUrl) throw new HttpError(400, 'Enter the Ollama address first.');
    const res = await fetch(`${c.ollama.baseUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) }).catch((err: any) => {
      throw new HttpError(502, `Can't reach Ollama at ${c.ollama.baseUrl}: ${err?.cause?.code || err.message}`);
    });
    if (!res.ok) throw new HttpError(502, `Ollama answered ${res.status}.`);
    const data: any = await res.json();
    return (data.models || []).map((m: any) => m.name).sort();
  }
  const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15_000) }).catch((err: any) => {
    throw new HttpError(502, `Can't reach OpenRouter: ${err?.cause?.code || err.message}`);
  });
  if (!res.ok) throw new HttpError(502, `OpenRouter answered ${res.status}.`);
  const data: any = await res.json();
  return (data.data || []).map((m: any) => m.id).sort();
}
