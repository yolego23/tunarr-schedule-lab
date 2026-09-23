// Runs sort and automation code in a sandboxed child process: no file or
// network access, a time limit (10 s by default for sorts), and a memory cap.
// Sorts: at most config.sandboxConcurrency at once, the rest wait. Automations
// are paced by their own job queue, and don't take sort slots (an automation
// builds lineups by running its channel's sort).
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(here, 'runner.ts');
const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// weekly-hours.js and analysis.js are ES modules for the server and browser;
// in the sandbox they are loaded as plain scripts.
const asScript = (file: string) => fs.readFileSync(file, 'utf8').replace(/^export /gm, '');
const SHARED = [asScript(path.join(config.sharedDir, 'weekly-hours.js')), asScript(path.join(config.sharedDir, 'analysis.js'))];
const SORT_PRELUDE = [...SHARED, fs.readFileSync(path.join(here, 'bootstrap.js'), 'utf8')].join('\n;\n');
const AUTOMATION_PRELUDE = [...SHARED, fs.readFileSync(path.join(here, 'bootstrap-automation.js'), 'utf8')].join('\n;\n');

export interface SortInput {
  pool: unknown[];
  current: unknown[];
  currentPlayingIndex: number;
  params: Record<string, unknown>;
  targetMs: number;
  scheduleStartMs: number;
  channel: { id: string; name: string; number: number };
  /** Global variables, as ctx.globals. */
  globals: Record<string, unknown>;
  /** Watch history and last-aired times, behind ctx.history. */
  history?: {
    channel: Record<string, { total: number; last: number | null; watches: Array<{ at: number; minutes: number }> }>;
    any: Record<string, { total: number; last: number | null; watches: Array<{ at: number; minutes: number; channelId?: string }> }>;
    lastAired: Record<string, number>;
  };
  /** Episodes on the lineup that aren't in the pool, so ctx.current still shows what they are. */
  lineupItems?: unknown[];
  /** Whether ctx.ai can be used (set up and allowed for sorts). */
  aiAvailable?: boolean;
}

/**
 * Handles helper calls from sort code (ctx.ai.ask, ctx.utils.claude). The
 * caller supplies it, so this module stays free of settings and the database.
 */
export type BridgeHandler = (kind: string, payload: any) => Promise<string>;

export interface RunOptions {
  timeLimitMs?: number;
  bridge?: BridgeHandler;
}

const noBridge: BridgeHandler = async kind => { throw new Error(`${kind === 'ai' || kind === 'claude' ? 'AI' : kind} isn't available here.`); };

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

export function runSort(code: string, input: SortInput, scoreCode?: string, options: number | RunOptions = {}): Promise<SortResult> {
  const opts: RunOptions = typeof options === 'number' ? { timeLimitMs: options } : options;
  return slot(() => runOnce({
    what: 'sort', prelude: SORT_PRELUDE, code, scoreCode, input,
    timeLimitMs: opts.timeLimitMs ?? config.sortTimeLimitMs, wallLimitMs: 5 * 60_000, bridge: opts.bridge ?? noBridge,
  })).then(r => ({ items: r.parsed.items, score: r.parsed.score, logs: r.parsed.logs || [], ms: r.ms }));
}

export interface AutomationResult {
  /** What run(ctx) returned (made JSON-safe), and the log. */
  result: unknown;
  logs: string[];
  ms: number;
}

/** Runs automation code. Its ctx helpers (build, apply, …) are served by `bridge`. */
export function runAutomation(code: string, input: unknown, options: { timeLimitMs: number; bridge: BridgeHandler }): Promise<AutomationResult> {
  return runOnce({
    what: 'automation', prelude: AUTOMATION_PRELUDE, code, input,
    timeLimitMs: options.timeLimitMs, wallLimitMs: 20 * 60_000, bridge: options.bridge,
  }).then(r => ({ result: r.parsed.result ?? null, logs: r.parsed.logs || [], ms: r.ms }));
}

interface RunSpec {
  what: 'sort' | 'automation';
  prelude: string;
  code: string;
  scoreCode?: string;
  input: unknown;
  timeLimitMs: number;
  /** Total time including helper calls. */
  wallLimitMs: number;
  bridge: BridgeHandler;
}

function runOnce(spec: RunSpec): Promise<{ parsed: any; ms: number }> {
  const { what, prelude, code, scoreCode, input, timeLimitMs, wallLimitMs, bridge } = spec;
  const The = what === 'sort' ? 'The sort' : 'The automation';
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

    const finish = (err: Error | null, result?: { parsed: any; ms: number }) => {
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
      if (usedMs > timeLimitMs) {
        finish(new SortError(`${The} took longer than ${timeLimitMs / 1000} seconds and was stopped.`));
      } else if (now - startedAt > wallLimitMs) {
        finish(new SortError(`${The} ran for ${wallLimitMs / 60_000} minutes (including helper calls) and was stopped.`));
      }
    }, 50);

    child.on('message', (msg: any) => {
      switch (msg?.kind) {
        case 'ready':
          child.send({ kind: 'start', prelude, code, scoreCode, input: JSON.stringify(input), timeLimitMs, filename: `${what}.js` });
          break;
        case 'running':
          clockRunning = true;
          lastTick = Date.now();
          break;
        case 'bridge': {
          bridgesOpen++;
          handleBridge(bridge, msg.request)
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
            finish(null, { parsed: JSON.parse(msg.result), ms: Number(msg.ms) || 0 });
          } catch (err: any) {
            finish(new SortError(`Could not read the ${what}'s result: ${err.message}`));
          }
          break;
        }
        case 'error':
          finish(new SortError(/Script execution timed out/.test(msg.error)
            ? `${The} took longer than ${timeLimitMs / 1000} seconds and was stopped.`
            : msg.error));
          break;
      }
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      const oom = /heap out of memory/i.test(stderr);
      finish(new SortError(oom
        ? `${The} ran out of memory (512 MB limit).`
        : `${The} sandbox stopped unexpectedly (${signal || `exit ${code}`}). ${stderr.trim().split('\n').slice(-3).join(' ')}`));
    });
    child.on('error', err => finish(new SortError(`Could not start the ${what} sandbox: ${err.message}`)));
  });
}

// ---------- host-side helpers the sandbox may call ----------
async function handleBridge(bridge: BridgeHandler, requestJson: string): Promise<string> {
  const req = JSON.parse(requestJson);
  return bridge(String(req.kind), req.payload || {});
}
