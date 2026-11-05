import ts from 'typescript';

/**
 * Clock audit guard scanner (scripts/clock-guard.test.ts). Finds application-clock reads in a source
 * file with the TypeScript compiler API, so formatting, comments and line breaks cannot hide one:
 * - `now` of the global `Date`: `Date.now`, `Date['now']`, `{ now } = Date`, and the same through
 *   `globalThis.Date`, parentheses, type assertions or a local alias (`const D = Date`);
 * - `new Date()` with no arguments, including `new Date`, `new globalThis.Date()`, `new (Date)()` and
 *   `new D()` through an alias.
 * A file that declares its own `Date` binding (a shadowing import, parameter or variable) is still
 * scanned: shadowing the global is itself unusual enough to need an audited entry.
 */
export type AppClockKind = 'Date.now' | 'new Date()';

export interface AppClockUse {
  /** The enclosing named function chain, outermost first (`<module>` at the top level). */
  readonly fn: string;
  readonly kind: AppClockKind;
  /** 0-based occurrence of this kind within `fn`, in source order. */
  readonly index: number;
  /** 1-based line, for messages only (not part of the key). */
  readonly line: number;
}

const unwrap = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (
    ts.isParenthesizedExpression(x) ||
    ts.isAsExpression(x) ||
    ts.isNonNullExpression(x) ||
    ts.isTypeAssertionExpression(x) ||
    ts.isSatisfiesExpression(x)
  )
    x = x.expression;
  return x;
};

const literalName = (e: ts.Expression): string | null => {
  const x = unwrap(e);
  return ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) ? x.text : null;
};

const nameOf = (n: ts.PropertyName | ts.BindingName | undefined): string | null => {
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) return n.text;
  if (ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isComputedPropertyName(n)) return literalName(n.expression);
  return null;
};

/** The name a function-like node is known by, or null for an anonymous one. */
function functionName(n: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isGetAccessorDeclaration(n) ||
      ts.isSetAccessorDeclaration(n) ||
      ts.isClassDeclaration(n) ||
      ts.isClassExpression(n) ||
      ts.isFunctionExpression(n)) &&
    n.name
  )
    return nameOf(n.name);
  if (ts.isConstructorDeclaration(n)) return 'constructor';
  if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isClassExpression(n)) && n.parent) {
    const p = n.parent;
    if (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p))
      return nameOf(p.name);
  }
  return null;
}

const SCOPES = (n: ts.Node) => ts.isFunctionLike(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n);

function enclosing(n: ts.Node): string {
  const names: string[] = [];
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (!SCOPES(p)) continue;
    const name = functionName(p);
    if (name !== null) names.unshift(name);
  }
  return names.length === 0 ? '<module>' : names.join('.');
}

export function findAppClockUses(text: string, fileName = 'scan.ts'): AppClockUse[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = new Set<string>();
  const isGlobalThis = (e: ts.Expression) => {
    const x = unwrap(e);
    return ts.isIdentifier(x) && (x.text === 'globalThis' || x.text === 'window' || x.text === 'self');
  };
  const isDate = (e: ts.Expression): boolean => {
    const x = unwrap(e);
    if (ts.isIdentifier(x)) return x.text === 'Date' || aliases.has(x.text);
    if (ts.isPropertyAccessExpression(x)) return x.name.text === 'Date' && isGlobalThis(x.expression);
    if (ts.isElementAccessExpression(x))
      return literalName(x.argumentExpression) === 'Date' && isGlobalThis(x.expression);
    return false;
  };
  // Aliases first (a use may precede its alias in source order, e.g. inside a hoisted function).
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isDate(n.initializer))
      aliases.add(n.name.text);
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left) &&
      isDate(n.right)
    )
      aliases.add(n.left.text);
    ts.forEachChild(n, collect);
  };
  // Two passes reach alias chains (`const A = Date; const B = A;`).
  collect(sf);
  collect(sf);

  const hits: { fn: string; kind: AppClockKind; pos: number }[] = [];
  const hit = (n: ts.Node, kind: AppClockKind) => hits.push({ fn: enclosing(n), kind, pos: n.getStart(sf) });
  const bindsNow = (p: ts.ObjectBindingPattern) =>
    p.elements.some((el) => nameOf(el.propertyName ?? el.name) === 'now');
  const literalHasNow = (o: ts.ObjectLiteralExpression) =>
    o.properties.some(
      (pr) =>
        (ts.isShorthandPropertyAssignment(pr) && pr.name.text === 'now') ||
        (ts.isPropertyAssignment(pr) && nameOf(pr.name) === 'now'),
    );
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'now' && isDate(n.expression)) hit(n, 'Date.now');
    else if (
      ts.isElementAccessExpression(n) &&
      literalName(n.argumentExpression) === 'now' &&
      isDate(n.expression)
    )
      hit(n, 'Date.now');
    else if (ts.isVariableDeclaration(n) && n.initializer && ts.isObjectBindingPattern(n.name)) {
      if (isDate(n.initializer) && bindsNow(n.name)) hit(n, 'Date.now');
    } else if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isObjectLiteralExpression(unwrap(n.left)) &&
      isDate(n.right) &&
      literalHasNow(unwrap(n.left) as ts.ObjectLiteralExpression)
    )
      hit(n, 'Date.now');
    else if (ts.isNewExpression(n) && isDate(n.expression) && (n.arguments?.length ?? 0) === 0)
      hit(n, 'new Date()');
    ts.forEachChild(n, visit);
  };
  visit(sf);

  hits.sort((a, b) => a.pos - b.pos);
  const seen = new Map<string, number>();
  return hits.map((h) => {
    const k = `${h.fn}\u0000${h.kind}`;
    const index = seen.get(k) ?? 0;
    seen.set(k, index + 1);
    return { fn: h.fn, kind: h.kind, index, line: sf.getLineAndCharacterOfPosition(h.pos).line + 1 };
  });
}
