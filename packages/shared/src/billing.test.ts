import { describe, expect, it } from 'vitest';
import { addMonth, amountInWords, documentNumber, financialYear, formatInr, gst, placeOfSupply, rupeesToPaise, validGstin } from './billing';

describe('billing helpers', () => {
  it('money in paise, Indian grouping and words', () => {
    expect(formatInr(12345678)).toBe('₹1,23,456.78');
    expect(formatInr(50)).toBe('₹0.50');
    expect(rupeesToPaise('1,499.5')).toBe(149950);
    expect(rupeesToPaise('499')).toBe(49900);
    expect(rupeesToPaise('4.999')).toBeNull();
    expect(amountInWords(12345678)).toBe('Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six and Seventy Eight Paise Only');
    expect(amountInWords(58882)).toBe('Rupees Five Hundred Eighty Eight and Eighty Two Paise Only');
    expect(amountInWords(1_25_00_000_00)).toBe('Rupees One Crore Twenty Five Lakh Only');
  });

  it('GSTIN check digit and place of supply', () => {
    expect(validGstin('27AAPFU0939F1ZV')).toBe(true);
    expect(validGstin('27AAPFU0939F1ZX')).toBe(false);
    expect(validGstin('99AAPFU0939F1ZV')).toBe(false);
    expect(placeOfSupply({ gstin: '27AAPFU0939F1ZV' }, '07')).toBe('27');
    expect(placeOfSupply({ stateCode: '29' }, '07')).toBe('29');
    expect(placeOfSupply({}, '07')).toBe('07');
  });

  it('CGST + SGST within the state, IGST across states', () => {
    expect(gst(49900, 1800, '07', '07')).toEqual({ taxablePaise: 49900, cgstPaise: 4491, sgstPaise: 4491, igstPaise: 0, totalPaise: 58882, kind: 'intra' });
    expect(gst(49900, 1800, '07', '27')).toEqual({ taxablePaise: 49900, cgstPaise: 0, sgstPaise: 0, igstPaise: 8982, totalPaise: 58882, kind: 'inter' });
    // Odd paise: each half rounded.
    expect(gst(99, 1800, '07', '07')).toMatchObject({ cgstPaise: 9, sgstPaise: 9, totalPaise: 117 });
  });

  it('financial year in IST, document numbers within 16 characters, monthly periods', () => {
    expect(financialYear(new Date('2026-03-31T18:29:00Z'))).toBe('25-26');
    expect(financialYear(new Date('2026-03-31T18:31:00Z'))).toBe('26-27');
    expect(documentNumber('INV', '26-27', 7)).toBe('INV/26-27/0007');
    expect(documentNumber('RCPT', '26-27', 12345).length).toBeLessThanOrEqual(16);
    expect(addMonth(new Date('2026-01-31T10:00:00Z')).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonth(new Date('2026-11-08T04:00:00Z')).toISOString()).toBe('2026-12-08T04:00:00.000Z');
  });
});
