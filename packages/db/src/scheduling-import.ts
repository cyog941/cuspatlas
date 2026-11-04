import {
  ENGAGEMENT_EXPORT_FORMAT,
  SCHEDULING_EXPORT_FORMAT,
  type SchedulingExport,
} from '@cuspatlas/contracts';
import type pg from 'pg';
import { type ExportDocument, type ImportOptions, importExports } from './export-import';

export { ENGAGEMENT_EXPORT_FORMAT, SCHEDULING_EXPORT_FORMAT };

/**
 * Re-imports an S17 scheduling export (with its companion E9 and C18 documents, which it references
 * and is referenced by) into a synthetic database for one tenant. One transaction, every foreign key
 * validated across all documents before the commit: see `importExports`.
 */
export function importSchedulingExport(
  pool: pg.Pool,
  tenantId: string,
  doc: SchedulingExport,
  companions: readonly ExportDocument[] = [],
  options: ImportOptions = {},
): Promise<Record<string, number>> {
  return importExports(pool, tenantId, [doc, ...companions], options);
}
