import { describe, expect, it } from 'vitest';
import { csvCell, parseCsv, parseCsvObjects, toCsv } from './csv';

describe('csv', () => {
  it('parses quotes, escaped quotes, CRLF, embedded newlines and BOM', () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n1,,3\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['1', '', '3'],
    ]);
  });

  it('skips blank lines and keeps a trailing row without newline', () => {
    expect(parseCsv('a,b\n\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a\n"oops')).toThrow(/Unterminated/);
  });

  it('normalizes headers', () => {
    const { headers, rows } = parseCsvObjects('Asset Tag,Position-U\n A1 , 5 ');
    expect(headers).toEqual(['asset_tag', 'position_u']);
    expect(rows).toEqual([{ asset_tag: 'A1', position_u: '5' }]);
  });

  it('neutralizes spreadsheet formulas and quotes when needed', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-cmd')).toBe("'-cmd");
    expect(csvCell('@SUM')).toBe("'@SUM");
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
  });

  it('round-trips through toCsv/parseCsv', () => {
    const out = toCsv(['h1', 'h2'], [['a "q"', 'b\nc']]);
    expect(parseCsv(out)).toEqual([
      ['h1', 'h2'],
      ['a "q"', 'b\nc'],
    ]);
  });
});
