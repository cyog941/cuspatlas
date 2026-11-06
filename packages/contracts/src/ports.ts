import type { ActorContext, PrincipalKind, SecurityAttemptEvent } from './context';

/** Query surface handed to domain work inside a tenant transaction. Parameterized SQL only. */
export interface TenantTransaction {
  readonly ctx: ActorContext;
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number }>;
  /**
   * Runs `work` inside a savepoint: on a throw, only the work's writes are undone and the
   * transaction stays usable (the command boundary uses it to record a refusal durably).
   */
  savepoint<T>(work: () => Promise<T>): Promise<T>;
}

export type WithTenantTransaction = <T>(
  ctx: ActorContext,
  work: (tx: TenantTransaction) => Promise<T>,
) => Promise<T>;

/** A membership row as read live from the database. */
export interface MembershipRecord {
  readonly tenantId: string;
  readonly principalId: string;
  readonly principal: PrincipalKind;
  readonly scopes: readonly string[];
  /** null = all locations in the tenant. */
  readonly locationRefs: readonly string[] | null;
  readonly active: boolean;
}

export interface MembershipSource {
  /** Live lookup; never cached. Returns null when no membership row exists. */
  load(principalId: string, tenantId: string): Promise<MembershipRecord | null>;
}

export type SecurityAttemptInput = Omit<SecurityAttemptEvent, 'attemptRef' | 'occurredAt'>;

export interface SecurityAttemptSink {
  /** Persists through an independent connection in its own transaction. Throws if unavailable. */
  record(attempt: SecurityAttemptInput): Promise<SecurityAttemptEvent>;
}
