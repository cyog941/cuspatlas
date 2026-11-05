/**
 * A1 shared-representation lint over JSON Schema documents. `Money` is `{ currency, minor }`, an
 * entity reference is an opaque `<entity>Ref`, timestamps carry a zone (`format: date-time`, RFC 3339
 * offsets) and no contract carries a tenant field. A violation is a defect, not a permitted variant.
 */

type Json = { readonly [k: string]: unknown };
const isObj = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `...Id` properties that are not entity references (each with its reason). */
export const NON_ENTITY_ID_FIELDS: Readonly<Record<string, string>> = {
  correlationId: 'request correlation identifier, not a record reference',
  providerEventId: "an external provider's own event identifier, stored verbatim for receipt dedupe",
  jobSigningKeyId: 'a public signing-key identifier for bridge job verification',
  sourceId: "a migration source system's own record identifier, kept verbatim as provenance (M3-M6)",
  guarantorSourceId:
    "a migration source system's own guarantor identifier, kept verbatim for opening-balance reconciliation (M5-M6)",
};

const MONEY_SCALAR = /(amount|Minor$|cents|Cents|price|Price|balance|Balance)/;
const isMoneyShape = (node: Json): boolean => {
  const props = isObj(node.properties) ? Object.keys(node.properties) : [];
  return props.includes('currency') && props.includes('minor');
};

export interface RepresentationDefect {
  /** `<file>#/$defs/<Def>` (or the JSON pointer) and property path. */
  readonly at: string;
  readonly rule: 'tenantField' | 'bareEntityId' | 'scalarMoney' | 'zonelessTimestamp' | 'openObject';
  readonly field: string;
  readonly message: string;
}

/**
 * Lints one schema node (usually a `$defs` entry) recursively. `requestSide` additionally forbids
 * open objects (unknown properties must be rejected, never stripped).
 */
export function lintRepresentation(node: unknown, at: string, requestSide = false): RepresentationDefect[] {
  const out: RepresentationDefect[] = [];
  const walk = (n: unknown, path: string, moneyOwner: boolean): void => {
    if (Array.isArray(n)) {
      n.forEach((x, i) => {
        walk(x, `${path}/${i}`, false);
      });
      return;
    }
    if (!isObj(n)) return;
    if (isObj(n.properties)) {
      const money = isMoneyShape(n);
      if (requestSide && n.additionalProperties !== false && n.type === 'object') {
        out.push({
          at: `${at}${path}`,
          rule: 'openObject',
          field: '',
          message: 'request object accepts unknown properties',
        });
      }
      for (const [k, v] of Object.entries(n.properties)) {
        const p = isObj(v) ? v : {};
        const where = `${at}${path}`;
        if (/^tenant/i.test(k)) {
          out.push({
            at: where,
            rule: 'tenantField',
            field: k,
            message: `${k}: tenant comes from the authenticated context`,
          });
        }
        if (/(Id|ID|_id)$/.test(k) && !/^tenant/i.test(k) && !Object.hasOwn(NON_ENTITY_ID_FIELDS, k)) {
          const entity = k.replace(/(Id|ID|_id)$/, '');
          out.push({
            at: where,
            rule: 'bareEntityId',
            field: k,
            message: `${k}: use the opaque ${entity}Ref`,
          });
        }
        const scalar = p.type === 'integer' || p.type === 'number';
        if (scalar && MONEY_SCALAR.test(k) && !(money && k === 'minor')) {
          out.push({
            at: where,
            rule: 'scalarMoney',
            field: k,
            message: `${k}: an amount is Money { currency, minor }`,
          });
        }
        if (/At$/.test(k) && p.type === 'string' && p.format !== 'date-time') {
          out.push({
            at: where,
            rule: 'zonelessTimestamp',
            field: k,
            message: `${k}: a timestamp is format date-time with an offset`,
          });
        }
      }
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === '$defs') continue;
      walk(v, `${path}/${k}`, moneyOwner);
    }
  };
  walk(node, '', false);
  return out;
}
