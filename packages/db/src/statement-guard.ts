/**
 * Guard for statements issued by domain work inside a tenant transaction. Domain code uses single,
 * parameterized statements; anything that could end, restart or re-scope the transaction, change
 * session context or call server administration functions is refused before it reaches PostgreSQL.
 * This is defense in depth on top of RLS and the restricted runtime role, not a SQL parser.
 */
const CONTROL =
  /^\s*(begin|start|commit|end|rollback|abort|savepoint|release|prepare|execute|deallocate|set|reset|discard|listen|unlisten|notify|lock|copy|do|call|vacuum|analyze|checkpoint|load)\b/i;

export function assertDomainStatement(text: string): void {
  if (
    CONTROL.test(text) ||
    text.includes(';') ||
    /--|\/\*/.test(text) ||
    /\bset_config\s*\(/i.test(text) ||
    /\bpg_[a-z0-9_]*\s*\(/i.test(text)
  ) {
    throw new Error('Statement is not available to domain work');
  }
}
