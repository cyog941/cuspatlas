import type { MembershipSource } from '@cuspatlas/contracts';
import { executeOnce } from '../commands/execute-once';
import type { CommandExecutor } from '../commands/executor';
import { createNavigationReads } from '../navigation/navigation';
import { createPreferenceOperations } from '../preferences/preferences';
import { createMeasureReads, type FinancialMeasuresPort } from '../reporting/measures';
import { type ComposerDeps, createComposerBase } from './framework';
import { type ComposerProducers, createReadComposers, DEFAULT_PRODUCERS } from './read-composers';

/**
 * One service for the A batch 3 read surfaces (A21 composers; later A16, A17, A18, A22, A24). REST and
 * MCP call it through one operation table (apps/api/src/routes/read-ops.ts).
 */
export interface ReadSurfaceDeps extends ComposerDeps {
  /** Composer producers; a missing one (null) is reported `unavailable`. Defaults to every published read. */
  readonly producers?: Partial<ComposerProducers>;
  /** Live membership lookup (A24 navigation evaluates many actions against one load). */
  readonly memberships?: MembershipSource;
  /** Durable command executor for the preference and administration commands. */
  readonly execute?: CommandExecutor;
  /** A16 small-cell suppression threshold (default 11, pending approval). */
  readonly suppressionThreshold?: number;
  /** A16 financial measures: the B11 claim measures as published by billing (same caller). */
  readonly financialMeasures?: FinancialMeasuresPort;
}

export function createReadSurfaceService(deps: ReadSurfaceDeps) {
  const base = createComposerBase(deps);
  return {
    ...createReadComposers(base, { ...DEFAULT_PRODUCERS, ...deps.producers }),
    ...createNavigationReads(base, deps.memberships),
    ...createPreferenceOperations(base, { execute: deps.execute ?? executeOnce }),
    ...createMeasureReads(base, {
      ...(deps.suppressionThreshold === undefined ? {} : { suppressionThreshold: deps.suppressionThreshold }),
      ...(deps.financialMeasures ? { financial: deps.financialMeasures } : {}),
    }),
  };
}

export type ReadSurfaceService = ReturnType<typeof createReadSurfaceService>;
