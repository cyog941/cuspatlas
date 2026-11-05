import { type ComposerDeps, createComposerBase } from './framework';
import { type ComposerProducers, createReadComposers, DEFAULT_PRODUCERS } from './read-composers';

/**
 * One service for the A batch 3 read surfaces (A21 composers; later A16, A17, A18, A22, A24). REST and
 * MCP call it through one operation table (apps/api/src/routes/read-ops.ts).
 */
export interface ReadSurfaceDeps extends ComposerDeps {
  /** Composer producers; a missing one (null) is reported `unavailable`. Defaults to every published read. */
  readonly producers?: Partial<ComposerProducers>;
}

export function createReadSurfaceService(deps: ReadSurfaceDeps) {
  const base = createComposerBase(deps);
  return {
    ...createReadComposers(base, { ...DEFAULT_PRODUCERS, ...deps.producers }),
  };
}

export type ReadSurfaceService = ReturnType<typeof createReadSurfaceService>;
