import { describe, expect, it } from 'vitest';
import { IrrError, expandAsSet, parseIrrResponse, routeObjectsOf, type Irr } from './irr';
import { irrAnswer } from '../../../test/simulators/irrd';

const irr: Irr = { server: 'test', query: async (q) => parseIrrResponse(irrAnswer(q)) };

describe('IRR', () => {
  it('parses IRRd answers', () => {
    expect(parseIrrResponse('A15\nAS1 AS2 AS-X\nC\n')).toEqual(['AS1', 'AS2', 'AS-X']);
    expect(parseIrrResponse('C\n')).toEqual([]);
    expect(parseIrrResponse('D\n')).toBeNull();
    expect(() => parseIrrResponse('F Unrecognised command')).toThrow(IrrError);
    expect(() => parseIrrResponse('<html>')).toThrow(/unexpected/);
  });

  it('expands AS-SETs recursively and lists direct members', async () => {
    expect(await expandAsSet(irr, 'AS152565:AS-JOYSVC')).toEqual({ asns: [152565, 210000, 64999], direct: ['AS152565', 'AS-EXAMPLE', 'AS64999'] });
    expect(await expandAsSet(irr, 'AS-NOPE')).toBeNull();
  });

  it('route objects by origin, IPv4 and IPv6', async () => {
    expect(await routeObjectsOf(irr, 210000)).toEqual(['45.10.20.0/22', '45.10.30.0/24']);
    expect(await routeObjectsOf(irr, 65001)).toEqual([]);
  });
});
