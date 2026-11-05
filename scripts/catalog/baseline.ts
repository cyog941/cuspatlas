import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CatalogOperation, DeprecationEntry } from '../../packages/contracts/src/catalog/catalog';
import {
  type Baseline,
  type Change,
  classifyChange,
  summarizeInput,
} from '../../packages/contracts/src/catalog/change-control';
import { ROOT } from './build-catalog';
import { defsOf, type Json, loadSchemaFiles, parseSchemaRef } from './schemas';

export const BASELINE_PATH = 'packages/contracts/src/catalog/baseline.json';
export const BASELINE_VERSION = 2;

/** The published contract of the current catalog (what change control compares against). */
export function buildBaseline(catalog: readonly CatalogOperation[], version = BASELINE_VERSION): Baseline {
  const files = loadSchemaFiles();
  return {
    version,
    operations: catalog.map((o) => {
      const ref = o.rest?.requestSchema ? parseSchemaRef(o.rest.requestSchema) : null;
      const doc = ref ? (files[ref.file] as Json) : null;
      return {
        operation: o.operation,
        transports: o.transports,
        scope: o.scope,
        principals: o.principals,
        ...(o.rest ? { rest: { method: o.rest.method, path: o.rest.path } } : {}),
        ...(o.mcpTool ? { mcpTool: o.mcpTool } : {}),
        ...(ref && doc ? { input: summarizeInput(defsOf(doc)[ref.def], doc) } : {}),
        idempotency: o.idempotency,
        refusals: [...o.refusals].sort(),
      };
    }),
  };
}

export function readBaseline(root = ROOT): Baseline {
  return JSON.parse(readFileSync(resolve(root, BASELINE_PATH), 'utf8')) as Baseline;
}

/** A-M1: minimum announced-to-sunset window (A-D1 pending; 90 days, overridable for review). */
export const MIN_DEPRECATION_WINDOW_DAYS = Number(process.env.CUSPATLAS_DEPRECATION_WINDOW_DAYS ?? 90);

const dayNumber = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

/**
 * Breaking changes the gate refuses. `deprecations` must be the entries as they existed at the merge
 * base (an entry added or edited in the same change never counts). A breaking change passes only
 * when its entry was announced before its sunset, the window is at least `minWindowDays`, and the
 * sunset has passed.
 */
export function gateViolations(
  changes: readonly Change[],
  deprecations: readonly DeprecationEntry[],
  today: string,
  minWindowDays = MIN_DEPRECATION_WINDOW_DAYS,
): string[] {
  const dep = new Map(deprecations.map((d) => [d.operation, d]));
  const why = (d: DeprecationEntry | undefined): string | null => {
    if (!d) return 'no deprecation entry with a sunset date at the merge base';
    if (!(d.announced < d.sunset)) {
      return `deprecation announced ${d.announced} is not before its sunset ${d.sunset}`;
    }
    if (dayNumber(d.sunset) - dayNumber(d.announced) < minWindowDays) {
      return `deprecation window ${d.announced}..${d.sunset} is shorter than ${minWindowDays} days`;
    }
    if (d.sunset > today) return `deprecated but its sunset ${d.sunset} has not passed`;
    return null;
  };
  return changes
    .filter((c) => c.class === 'breaking')
    .flatMap((c) => {
      const reason = why(dep.get(c.operation));
      return reason ? [`${c.operation} ${c.path}: ${c.reason} (${reason})`] : [];
    });
}

/** Reads `path` at git `ref`; null when the path does not exist there. */
export type GitShow = (ref: string, path: string) => string | null;

const git = (args: string[]): string | null => {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

export const gitShow: GitShow = (ref, path) => {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch {
    return null;
  }
};

/**
 * The change-control base: `CUSPATLAS_CATALOG_BASE_REF` when set, else the merge base with
 * `origin/main`, else (no remote ref) the committed parent `HEAD~`, else `HEAD`.
 */
export function resolveBaseRef(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CUSPATLAS_CATALOG_BASE_REF) return env.CUSPATLAS_CATALOG_BASE_REF;
  if (git(['rev-parse', '--verify', '--quiet', 'origin/main'])) {
    return git(['merge-base', 'origin/main', 'HEAD']) || 'origin/main';
  }
  return git(['rev-parse', '--verify', '--quiet', 'HEAD~']) ? 'HEAD~' : 'HEAD';
}

export const DEPRECATIONS_PATH = 'packages/contracts/src/catalog/deprecations.json';

export interface BaseState {
  readonly ref: string;
  /** The published baseline at the base, or null when the base predates the catalog. */
  readonly baseline: Baseline | null;
  readonly deprecations: readonly DeprecationEntry[];
}

/** Baseline and deprecations as committed at `ref`. A present but unreadable file is fatal. */
export function loadBaseState(ref: string, show: GitShow = gitShow): BaseState {
  const parse = <T>(path: string): T | null => {
    const raw = show(ref, path);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new Error(`${path} at ${ref} is corrupt; change control cannot proceed`);
    }
  };
  return {
    ref,
    baseline: parse<Baseline>(BASELINE_PATH),
    deprecations: parse<DeprecationEntry[]>(DEPRECATIONS_PATH) ?? [],
  };
}

/**
 * A-M1 gate. The working-tree baseline must exist and parse unless this is an explicit first
 * publication (`--first-publication`); breaking changes are judged against the baseline and the
 * deprecations committed at the base, so neither a deleted baseline nor a deprecation written in
 * the same change opens the gate. A base that predates the catalog has nothing published to protect.
 */
export function changeControlRefusals(input: {
  readonly current: Baseline;
  readonly workingTreeBaseline: () => Baseline;
  readonly base: BaseState;
  readonly today: string;
  readonly firstPublication?: boolean | undefined;
  readonly minWindowDays?: number;
}): string[] {
  if (!input.firstPublication) {
    let ok = false;
    try {
      const committed = input.workingTreeBaseline();
      ok = typeof committed === 'object' && committed !== null && Array.isArray(committed.operations);
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new Error(
        `baseline ${BASELINE_PATH} is missing or corrupt; refusing (pass --first-publication only for an explicit first publication)`,
      );
    }
  }
  if (!input.base.baseline) return [];
  return gateViolations(
    classifyChange(input.base.baseline, input.current),
    input.base.deprecations,
    input.today,
    input.minWindowDays,
  );
}

export function compareWithBaseline(prev: Baseline, next: Baseline): Change[] {
  return classifyChange(prev, next);
}
