import { composeWorker } from './compose';

/**
 * `start:worker`: composes the worker from the environment and ticks until SIGINT or SIGTERM; the tick
 * in progress completes, then the pools close. Log lines are JSON with fixed codes only (no secret, no
 * patient, no recipient, no delivery key).
 */
const write = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`);

async function main(): Promise<void> {
  const interval = Number(process.env.CUSPATLAS_WORKER_INTERVAL_MS ?? 5000);
  if (!(Number.isInteger(interval) && interval >= 100 && interval <= 3_600_000)) {
    throw new Error('CUSPATLAS_WORKER_INTERVAL_MS must be an integer between 100 and 3600000');
  }
  const worker = await composeWorker(process.env, { log: write });
  const stop = new AbortController();
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => stop.abort());
  try {
    await worker.run(stop.signal, { intervalMs: interval });
  } finally {
    await worker.close();
  }
}

main().catch((err: unknown) => {
  // Configuration errors are authored messages without secrets; anything else is reported by kind.
  const message =
    err instanceof Error && /^(CUSPATLAS_|Refusing|The bridge signing key)/.test(err.message)
      ? err.message
      : 'startup failed';
  process.stderr.write(`cuspatlas worker: ${message}\n`);
  process.exit(1);
});
