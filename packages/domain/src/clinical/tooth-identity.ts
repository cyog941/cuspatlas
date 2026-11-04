/**
 * C6 canonical tooth identity (C-D1, recommended-pending-clinical-approval; docs/adr/0005).
 *
 * The canonical reference is anatomical and independent of any numbering system:
 * `perm-<quadrant>-<1..8>` (permanent; position 1 = central incisor .. 8 = third molar),
 * `prim-<quadrant>-<1..5>` (primary; 1 = central incisor .. 5 = second molar) and
 * `sn-<quadrant>-<1..4>` (supernumerary; an index, not a position), quadrants ur, ul, ll, lr.
 * Universal (US default display) and FDI are projections. Conversion is lossless for supported
 * anatomy and refused, never guessed, elsewhere: supernumerary teeth have no counterpart here
 * (C-S1-Q1: the exact refusal list awaits the clinical reviewer). Pure functions, no I/O.
 */
export const TOOTH_VOCABULARY = 'cuspatlas-tooth.v1';

export type ToothSystem = 'universal' | 'fdi';
export type ToothInputSystem = ToothSystem | 'canonical';
export type Quadrant = 'ur' | 'ul' | 'll' | 'lr';
export type Dentition = 'permanent' | 'primary' | 'supernumerary';
export type ToothClass = 'anterior' | 'posterior' | 'supernumerary';

export interface ToothInfo {
  readonly canonicalRef: string;
  readonly dentition: Dentition;
  readonly quadrant: Quadrant;
  readonly position: number;
  readonly toothClass: ToothClass;
}

export type ParseResult =
  | { readonly ok: true; readonly canonicalRef: string }
  | { readonly ok: false; readonly reason: 'unknown_code' };
export type ConvertResult =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: 'unknown_code' | 'no_counterpart' };

const QUADRANTS: readonly Quadrant[] = ['ur', 'ul', 'll', 'lr'];
const PRIMARY_LETTERS = 'ABCDEFGHIJKLMNOPQRST';
const CANONICAL = /^(perm|prim|sn)-(ur|ul|ll|lr)-([1-8])$/;

const MAX_POSITION: Readonly<Record<Dentition, number>> = { permanent: 8, primary: 5, supernumerary: 4 };
const PREFIX: Readonly<Record<string, Dentition>> = {
  perm: 'permanent',
  prim: 'primary',
  sn: 'supernumerary',
};
const PREFIX_OF: Readonly<Record<Dentition, string>> = {
  permanent: 'perm',
  primary: 'prim',
  supernumerary: 'sn',
};

/** Anatomical metadata of a canonical reference, or null if it is not one. */
export function toothInfo(canonicalRef: string): ToothInfo | null {
  const m = CANONICAL.exec(canonicalRef);
  if (!m) return null;
  const dentition = PREFIX[m[1] as string] as Dentition;
  const position = Number(m[3]);
  if (position > MAX_POSITION[dentition]) return null;
  const toothClass: ToothClass =
    dentition === 'supernumerary' ? 'supernumerary' : position <= 3 ? 'anterior' : 'posterior';
  return { canonicalRef, dentition, quadrant: m[2] as Quadrant, position, toothClass };
}

const canonical = (dentition: Dentition, quadrant: Quadrant, position: number) =>
  `${PREFIX_OF[dentition]}-${quadrant}-${position}`;

/**
 * Universal: permanent 1-32 run from the upper right third molar across the upper arch to the upper
 * left third molar (16), then from the lower left third molar (17) to the lower right (32); primary
 * A-T follow the same path over second molars.
 */
function fromUniversal(code: string): string | null {
  if (/^([1-9]|[12][0-9]|3[0-2])$/.test(code)) {
    const n = Number(code);
    const q = QUADRANTS[Math.floor((n - 1) / 8)] as Quadrant;
    const i = (n - 1) % 8; // 0..7 along the path
    const position = q === 'ur' || q === 'll' ? 8 - i : i + 1;
    return canonical('permanent', q, position);
  }
  const idx = code.length === 1 ? PRIMARY_LETTERS.indexOf(code) : -1;
  if (idx < 0) return null;
  const q = QUADRANTS[Math.floor(idx / 5)] as Quadrant;
  const i = idx % 5;
  const position = q === 'ur' || q === 'll' ? 5 - i : i + 1;
  return canonical('primary', q, position);
}

function toUniversal(t: ToothInfo): string | null {
  const qi = QUADRANTS.indexOf(t.quadrant);
  if (t.dentition === 'permanent') {
    const i = t.quadrant === 'ur' || t.quadrant === 'll' ? 8 - t.position : t.position - 1;
    return String(qi * 8 + i + 1);
  }
  if (t.dentition === 'primary') {
    const i = t.quadrant === 'ur' || t.quadrant === 'll' ? 5 - t.position : t.position - 1;
    return PRIMARY_LETTERS[qi * 5 + i] ?? null;
  }
  return null;
}

/** FDI two-digit: quadrant 1-4 (permanent) or 5-8 (primary) and position 1-8 (1-5 primary). */
function fromFdi(code: string): string | null {
  const m = /^([1-8])([1-8])$/.exec(code);
  if (!m) return null;
  const qd = Number(m[1]);
  const position = Number(m[2]);
  const dentition: Dentition = qd <= 4 ? 'permanent' : 'primary';
  if (position > MAX_POSITION[dentition]) return null;
  return canonical(dentition, QUADRANTS[(qd - 1) % 4] as Quadrant, position);
}

function toFdi(t: ToothInfo): string | null {
  if (t.dentition === 'supernumerary') return null;
  const qd = QUADRANTS.indexOf(t.quadrant) + 1 + (t.dentition === 'primary' ? 4 : 0);
  return `${qd}${t.position}`;
}

/** Resolves an input code in any supported system to its canonical identity. */
export function parseTooth(input: { readonly system: ToothInputSystem; readonly code: string }): ParseResult {
  let ref: string | null = null;
  if (input.system === 'canonical') ref = toothInfo(input.code) ? input.code : null;
  else if (input.system === 'universal') ref = fromUniversal(input.code);
  else if (input.system === 'fdi') ref = fromFdi(input.code);
  return ref === null ? { ok: false, reason: 'unknown_code' } : { ok: true, canonicalRef: ref };
}

/** The display code of a canonical tooth in one system, or null when the system has no counterpart. */
export function toothDisplay(canonicalRef: string, system: ToothSystem): string | null {
  const t = toothInfo(canonicalRef);
  if (!t) return null;
  return system === 'universal' ? toUniversal(t) : toFdi(t);
}

/** Converts between systems; an unsupported tooth is an explicit refusal, never a best guess. */
export function convertToothRef(
  from: { readonly system: ToothInputSystem; readonly code: string },
  to: ToothSystem,
): ConvertResult {
  const parsed = parseTooth(from);
  if (!parsed.ok) return parsed;
  const code = toothDisplay(parsed.canonicalRef, to);
  return code === null ? { ok: false, reason: 'no_counterpart' } : { ok: true, code };
}

/**
 * Provisional synthetic surface scope per tooth class (C-S1-Q2 is blocking: the surface list and
 * which tooth types carry which surfaces are clinical values awaiting the reviewer). Engineering
 * placeholder: anterior M, D, I, F, L; posterior M, D, O, B, L; supernumerary none.
 */
export const PROVISIONAL_SURFACE_SCOPE: Readonly<Record<ToothClass, readonly string[]>> = {
  anterior: ['M', 'D', 'I', 'F', 'L'],
  posterior: ['M', 'D', 'O', 'B', 'L'],
  supernumerary: [],
};

export type SurfaceCheck =
  | { readonly ok: true; readonly surfaces: readonly string[] }
  | {
      readonly ok: false;
      readonly reason: 'surfacesNotForToothType' | 'surfaceNotForToothType' | 'duplicateSurface';
    };

/** Validates a surface set against the tooth type and returns it sorted (a set, not a sequence). */
export function checkSurfaces(canonicalRef: string, surfaces: readonly string[]): SurfaceCheck {
  const t = toothInfo(canonicalRef);
  const scope = t ? PROVISIONAL_SURFACE_SCOPE[t.toothClass] : [];
  if (scope.length === 0) return { ok: false, reason: 'surfacesNotForToothType' };
  if (new Set(surfaces).size !== surfaces.length) return { ok: false, reason: 'duplicateSurface' };
  if (surfaces.some((s) => !scope.includes(s))) return { ok: false, reason: 'surfaceNotForToothType' };
  return { ok: true, surfaces: [...surfaces].sort() };
}

/** The ToothRef projection returned by every clinical read. */
export function toothRef(canonicalRef: string, displaySystem: ToothSystem) {
  const t = toothInfo(canonicalRef);
  const universal = toothDisplay(canonicalRef, 'universal');
  const fdi = toothDisplay(canonicalRef, 'fdi');
  return {
    canonicalRef,
    dentition: t?.dentition ?? 'supernumerary',
    displaySystem,
    display: displaySystem === 'universal' ? universal : fdi,
    universal,
    fdi,
  } as const;
}
