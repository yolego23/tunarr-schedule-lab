// Runs sort code in a sandboxed child process: no file or network access, a
// time limit (10 s by default), and a memory cap. At most
// config.sandboxConcurrency children run at once; the rest wait in a queue.
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(here, 'runner.ts');
const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// weekly-hours.js and analysis.js are ES modules for the server and browser;
// in the sandbox they are loaded as plain scripts.
const asScript = (file: string) => fs.readFileSync(file, 'utf8').replace(/^export /gm, '');
const PRELUDE = [
  asScript(path.join(config.sharedDir, 'weekly-hours.js')),
  asScript(path.join(config.sharedDir, 'analysis.js')),
  fs.readFileSync(path.join(here, 'bootstrap.js'), 'utf8'),
].join('\n;\n');

export interface SortInput {
  pool: unknown[];
  current: unknown[];
  currentPlayingIndex: number;
  params: Record<string, unknown>;
  targetMs: number;
  scheduleStartMs: number;
  channel: { id: string; name: string; number: number };
}

export type SortOutputItem = { id: string } | { type: 'flex'; durationMs: number } | { ci: number };

export interface SortResult {
  items: SortOutputItem[];
  score: { total: number; breakdown: Record<string, unknown> } | null;
  logs: string[];
  ms: number;
}

export class SortError extends Error {
  logs: string[];
  constructor(message: string, logs: string[] = []) {
    super(message);
    this.logs = logs;
  }
}

// ---------- queue ----------
let running = 0;
const waiting: Array<() => void> = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= config.sandboxConcurrency) await new Promise<void>(resolve => waiting.push(resolve));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

export function runSort(code: string, input: SortInput, scoreCode?: string): Promise<SortResult> {
  return slot(() => runOnce(code, input, scoreCode));
}

function runOnce(code: string, input: SortInput, scoreCode?: string): Promise<SortResult> {
  return new Promise((resolve, reject) => {
    const child = fork(RUNNER, [], {
      execArgv: ['--permission', '--max-old-space-size=512', '--disable-warning=ExperimentalWarning'],
      // Nothing from the server's environment except the time zone, so sorts
      // read work and sleep hours in the same zone as the server.
      env: { TZ: process.env.TZ || SERVER_TZ, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', d => { stderr = (stderr + d).slice(-4000); });

    let settled = false;
    let usedMs = 0;
    let lastTick = 0;
    let clockRunning = false;
    let bridgesOpen = 0;
    const startedAt = Date.now();

    const finish = (err: Error | null, result?: SortResult) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      child.kill('SIGKILL');
      if (err) reject(err); else resolve(result!);
    };

    // Sandbox time excludes time spent waiting on host helpers (Claude calls).
    const timer = setInterval(() => {
      const now = Date.now();
      if (clockRunning && bridgesOpen === 0) usedMs += now - lastTick;
      lastTick = now;
      if (usedMs > config.sortTimeLimitMs) {
        finish(new SortError(`The sort took longer than ${config.sortTimeLimitMs / 1000} seconds and was stopped.`));
      } else if (now - startedAt > 5 * 60_000) {
        finish(new SortError('The sort ran for 5 minutes (including helper calls) and was stopped.'));
      }
    }, 50);

    child.on('message', (msg: any) => {
      switch (msg?.kind) {
        case 'ready':
          child.send({ kind: 'start', prelude: PRELUDE, code, scoreCode, input: JSON.stringify(input), timeLimitMs: config.sortTimeLimitMs });
          break;
        case 'running':
          clockRunning = true;
          lastTick = Date.now();
          break;
        case 'bridge': {
          bridgesOpen++;
          handleBridge(msg.request)
            .then(value => ({ ok: true, value }), (err: any) => ({ ok: false, value: err?.message || String(err) }))
            .then(({ ok, value }) => {
              bridgesOpen--;
              lastTick = Date.now();
              if (!settled) child.send({ kind: 'bridge-result', id: JSON.parse(msg.request).id, ok, value });
            });
          break;
        }
        case 'done': {
          try {
            const parsed = JSON.parse(msg.result);
            finish(null, { items: parsed.items, score: parsed.score, logs: parsed.logs || [], ms: Number(msg.ms) || 0 });
          } catch (err: any) {
            finish(new SortError(`Could not read the sort's result: ${err.message}`));
          }
          break;
        }
        case 'error':
          finish(new SortError(/Script execution timed out/.test(msg.error)
            ? `The sort took longer than ${config.sortTimeLimitMs / 1000} seconds and was stopped.`
            : msg.error));
          break;
      }
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      const oom = /heap out of memory/i.test(stderr);
      finish(new SortError(oom
        ? 'The sort ran out of memory (512 MB limit).'
        : `The sort sandbox stopped unexpectedly (${signal || `exit ${code}`}). ${stderr.trim().split('\n').slice(-3).join(' ')}`));
    });
    child.on('error', err => finish(new SortError(`Could not start the sort sandbox: ${err.message}`)));
  });
}

// ---------- host-side helpers the sandbox may call ----------
async function handleBridge(requestJson: string): Promise<string> {
  const req = JSON.parse(requestJson);
  if (req.kind === 'claude') return askClaude(req.payload || {});
  throw new Error(`Unknown helper "${req.kind}"`);
}

/**
 * ctx.utils.claude({ apiKey, prompt, system?, model?, maxTokens? }) -> text.
 * The API key comes from the sort's own settings.
 */
async function askClaude(opts: { apiKey?: string; prompt?: string; system?: string; model?: string; maxTokens?: number }): Promise<string> {
  const apiKey = String(opts.apiKey || '').trim();
  if (!apiKey) throw new Error('ctx.utils.claude needs an apiKey.');
  if (!opts.prompt) throw new Error('ctx.utils.claude needs a prompt.');
  const model = String(opts.model || 'claude-opus-5');
  const client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 2 });
  const params: Record<string, unknown> = {
    model,
    max_tokens: Math.min(Math.max(Number(opts.maxTokens) || 16000, 256), 64000),
    messages: [{ role: 'user', content: String(opts.prompt) }],
  };
  if (opts.system) params.system = String(opts.system);
  // Opus 5 / Fable 5.1 can decline a request; let the API retry it on a
  // suitable fallback model instead of failing the run.
  const useFallbacks = /^claude-(opus-5|fable-5-1)$/.test(model);
  if (useFallbacks) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  try {
    const response: any = useFallbacks
      ? await client.beta.messages.create(params as any)
      : await client.messages.create(params as any);
    if (response.stop_reason === 'refusal') {
      throw new Error(`Claude declined the request${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : ''}.`);
    }
    return (response.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Claude API: the API key was rejected.');
    if (err instanceof Anthropic.RateLimitError) throw new Error('Claude API: rate limited, try again shortly.');
    if (err instanceof Anthropic.APIError) throw new Error(`Claude API error ${err.status ?? ''}: ${err.message}`);
    throw err;
  }
}
