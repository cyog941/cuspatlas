/**
 * OR-02 state vocabularies: every persisted state code is served as `{code, shortCode, label, category,
 * terminal}`. Category is semantic only (no colour or layout).
 */
export type VocabularyCategory = 'lifecycle' | 'presence' | 'exception' | 'financial' | 'clinical';

export interface VocabularyEntry {
  readonly code: string;
  readonly shortCode: string;
  readonly label: string;
  readonly category: VocabularyCategory;
  readonly terminal: boolean;
}

export interface VocabularyDefinition {
  readonly name: string;
  /** DB CHECK columns (`table.column`) or domain constants (`domain:Name`) this vocabulary covers. */
  readonly sources: readonly string[];
  readonly entries: readonly VocabularyEntry[];
}

/** One registry per owning module; `version` changes whenever any entry of the module changes. */
export interface ModuleVocabularies {
  readonly module: string;
  readonly owner: 'F' | 'S' | 'C' | 'B' | 'E' | 'I' | 'M' | 'A';
  readonly version: string;
  readonly vocabularies: readonly VocabularyDefinition[];
}

export function vocabularyEntry(
  code: string,
  shortCode: string,
  label: string,
  category: VocabularyCategory,
  terminal: boolean,
): VocabularyEntry {
  return { code, shortCode, label, category, terminal };
}
