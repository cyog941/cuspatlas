import { describe, expect, it } from 'vitest';
import {
  checkSurfaces,
  convertToothRef,
  parseTooth,
  TOOTH_VOCABULARY,
  toothDisplay,
  toothInfo,
} from './tooth-identity';

/**
 * C6 tooth identity (C-D1, recommended-pending-clinical-approval): a canonical identity independent
 * of numbering, Universal and FDI as projections, conversion lossless for supported anatomy and
 * refused, never guessed, elsewhere. Synthetic engineering tests; no clinical validation.
 */
const UNIVERSAL_TO_FDI: readonly [string, string][] = [
  ['1', '18'],
  ['8', '11'],
  ['9', '21'],
  ['16', '28'],
  ['17', '38'],
  ['24', '31'],
  ['25', '41'],
  ['32', '48'],
  ['A', '55'],
  ['E', '51'],
  ['F', '61'],
  ['J', '65'],
  ['K', '75'],
  ['O', '71'],
  ['P', '81'],
  ['T', '85'],
];

describe('tooth identity conversion matrix', () => {
  it.each(UNIVERSAL_TO_FDI)('Universal %s is FDI %s, both ways', (u, f) => {
    expect(convertToothRef({ system: 'universal', code: u }, 'fdi')).toStrictEqual({ ok: true, code: f });
    expect(convertToothRef({ system: 'fdi', code: f }, 'universal')).toStrictEqual({ ok: true, code: u });
  });

  it('every permanent (1-32) and primary (A-T) Universal code round-trips through FDI and canonical', () => {
    const codes = [
      ...Array.from({ length: 32 }, (_, i) => String(i + 1)),
      ...'ABCDEFGHIJKLMNOPQRST'.split(''),
    ];
    const canon = new Set<string>();
    for (const code of codes) {
      const fdi = convertToothRef({ system: 'universal', code }, 'fdi');
      if (!fdi.ok) throw new Error(`no FDI for ${code}`);
      expect(convertToothRef({ system: 'fdi', code: fdi.code }, 'universal')).toStrictEqual({
        ok: true,
        code,
      });
      const parsed = parseTooth({ system: 'universal', code });
      if (!parsed.ok) throw new Error(`no canonical for ${code}`);
      canon.add(parsed.canonicalRef);
      expect(convertToothRef({ system: 'canonical', code: parsed.canonicalRef }, 'universal')).toStrictEqual({
        ok: true,
        code,
      });
    }
    expect(canon.size).toBe(52);
  });

  it('a primary and a permanent tooth in the same anatomical position have distinct canonical identities', () => {
    const primary = parseTooth({ system: 'universal', code: 'K' });
    const permanent = parseTooth({ system: 'universal', code: '20' });
    if (!primary.ok || !permanent.ok) throw new Error('parse failed');
    expect(primary.canonicalRef).not.toBe(permanent.canonicalRef);
    expect([
      toothInfo(primary.canonicalRef)?.dentition,
      toothInfo(permanent.canonicalRef)?.dentition,
    ]).toStrictEqual(['primary', 'permanent']);
    expect([
      toothInfo(primary.canonicalRef)?.quadrant,
      toothInfo(permanent.canonicalRef)?.quadrant,
    ]).toStrictEqual(['ll', 'll']);
  });

  it('supernumerary teeth convert to no numbering system: an explicit refusal, never a neighbour', () => {
    expect(parseTooth({ system: 'canonical', code: 'sn-ur-1' })).toMatchObject({ ok: true });
    for (const to of ['universal', 'fdi'] as const) {
      expect(convertToothRef({ system: 'canonical', code: 'sn-ur-1' }, to)).toStrictEqual({
        ok: false,
        reason: 'no_counterpart',
      });
    }
    expect(toothDisplay('sn-ur-1', 'universal')).toBeNull();
  });

  it.each([
    ['universal', '33'],
    ['universal', '0'],
    ['universal', 'U'],
    ['universal', '01'],
    ['fdi', '19'],
    ['fdi', '56'],
    ['fdi', '09'],
    ['fdi', 'A'],
    ['fdi', ''],
    ['canonical', 'perm-ur-9'],
    ['canonical', 'prim-ur-6'],
  ] as const)('%s %s is refused as an unknown code', (system, code) => {
    expect(parseTooth({ system, code })).toStrictEqual({ ok: false, reason: 'unknown_code' });
    expect(convertToothRef({ system, code }, 'universal')).toStrictEqual({
      ok: false,
      reason: 'unknown_code',
    });
  });

  it('the vocabulary version is recorded with the identity', () => {
    expect(TOOTH_VOCABULARY).toBe('cuspatlas-tooth.v1');
  });
});

describe('provisional surface scope per tooth type (C-S1-Q2 values pending reviewer)', () => {
  const canon = (code: string) => {
    const p = parseTooth({ system: 'universal', code });
    if (!p.ok) throw new Error('parse');
    return p.canonicalRef;
  };

  it('an anterior tooth takes incisal and facial, a posterior tooth takes occlusal and buccal', () => {
    expect(checkSurfaces(canon('8'), ['M', 'I', 'F'])).toStrictEqual({ ok: true, surfaces: ['F', 'I', 'M'] });
    expect(checkSurfaces(canon('3'), ['O', 'B', 'D'])).toStrictEqual({ ok: true, surfaces: ['B', 'D', 'O'] });
    expect(checkSurfaces(canon('8'), ['O'])).toStrictEqual({ ok: false, reason: 'surfaceNotForToothType' });
    expect(checkSurfaces(canon('3'), ['I'])).toStrictEqual({ ok: false, reason: 'surfaceNotForToothType' });
    expect(checkSurfaces(canon('3'), ['O', 'O'])).toStrictEqual({ ok: false, reason: 'duplicateSurface' });
  });

  it('a supernumerary tooth has no surface scope, so any surface-scoped finding is refused', () => {
    expect(checkSurfaces('sn-ll-2', ['M'])).toStrictEqual({ ok: false, reason: 'surfacesNotForToothType' });
  });
});
