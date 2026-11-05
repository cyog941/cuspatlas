import type { ListOrdering } from './list-envelope';

/** A20 / OR-01 registry of every catalog list operation (filled in A20 step 2). */
export interface ListOperationSpec {
  readonly rows: string;
  readonly ordering: ListOrdering;
}

export const LIST_OPERATIONS: Readonly<Record<string, ListOperationSpec>> = {};
