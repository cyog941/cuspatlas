import { describe, expect, it } from 'vitest';
import { csvExportCell, csvExportRow } from './adapter';

/** H2 M-8: staged source values are stored raw and neutralised only when exported as CSV. */
describe('csvExportCell', () => {
  it('neutralises every formula-leading value', () => {
    for (const v of ['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])
      expect(csvExportCell(v).startsWith("'") || csvExportCell(v).startsWith(`"'`)).toBe(true);
    expect(csvExportCell('=HYPERLINK("syn")')).toBe(`"'=HYPERLINK(""syn"")"`);
  });

  it('leaves ordinary values alone and quotes separators', () => {
    expect(csvExportCell('Avery')).toBe('Avery');
    expect(csvExportCell('1980-04-02')).toBe('1980-04-02');
    expect(csvExportCell('a,b')).toBe('"a,b"');
    expect(csvExportRow(['P001', '-1500', 'x"y'])).toBe(`P001,'-1500,"x""y"`);
  });
});
