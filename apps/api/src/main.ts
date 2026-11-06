import { startServer } from './server';

startServer(process.env).catch((err: unknown) => {
  // Configuration errors are authored messages without secrets; anything else is reported by kind.
  const message =
    err instanceof Error && /^(CUSPATLAS_|JWT |Refusing|The test issuer)/.test(err.message)
      ? err.message
      : 'startup failed';
  process.stderr.write(`cuspatlas api: ${message}\n`);
  process.exit(1);
});
