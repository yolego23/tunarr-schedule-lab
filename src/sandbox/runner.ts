// Child process that runs one sort. Started by sandbox/index.ts with Node's
// --permission flag (no file, child-process or worker access). The sort code
// runs in a vm context whose global object belongs to that context
// (DONT_CONTEXTIFY), so no host object is reachable from sort code: data goes
// in and results come out as JSON strings only.
//
// This file must not import anything but node: built-ins.
import vm from 'node:vm';

interface StartMessage {
  kind: 'start';
  prelude: string;
  code: string;
  scoreCode?: string;
  input: string;
  timeLimitMs: number;
}

let context: vm.Context | null = null;

function send(msg: unknown) {
  process.send!(msg);
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'stack' in err && typeof (err as any).stack === 'string') {
    // Keep the sort's own frames, drop the host's.
    const lines = String((err as any).stack).split('\n').filter((l: string) => !/node:|runner\.ts/.test(l));
    return lines.slice(0, 8).join('\n');
  }
  return String(err);
}

async function start(msg: StartMessage) {
  context = vm.createContext(vm.constants.DONT_CONTEXTIFY);
  const opts = (filename: string) => ({ filename, timeout: msg.timeLimitMs });
  vm.runInContext(msg.prelude, context, opts('helpers.js'));
  vm.runInContext(`var __input = ${JSON.stringify(msg.input)};`, context);
  vm.runInContext(`${msg.code}\n;globalThis.__run = typeof run === 'function' ? run : undefined;`, context, opts('sort.js'));
  if (msg.scoreCode) {
    vm.runInContext(`${msg.scoreCode}\n;globalThis.__score = typeof score === 'function' ? score : undefined;`, context, opts('score.js'));
  }
  send({ kind: 'running' });

  // Pass any ctx.utils.claude() requests up to the parent.
  const poll = setInterval(() => {
    const queued = JSON.parse(vm.runInContext('__bridgeDrain()', context!) as string) as string[];
    for (const q of queued) send({ kind: 'bridge', request: q });
  }, 20);
  try {
    const t0 = performance.now();
    const promise = vm.runInContext('__main()', context, { timeout: msg.timeLimitMs }) as Promise<string>;
    const resultJson = await promise;
    send({ kind: 'done', result: String(resultJson), ms: Math.round(performance.now() - t0) });
  } finally {
    clearInterval(poll);
  }
}

process.on('message', (msg: any) => {
  if (msg?.kind === 'start') {
    start(msg).catch(err => send({ kind: 'error', error: errorText(err) }));
  } else if (msg?.kind === 'bridge-result' && context) {
    const call = `__bridgeSettle(${Number(msg.id)}, ${msg.ok ? 'true' : 'false'}, ${JSON.stringify(String(msg.value))})`;
    vm.runInContext(call, context);
  }
});

send({ kind: 'ready' });
