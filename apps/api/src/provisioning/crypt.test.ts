import { describe, expect, it } from 'vitest';
import { sha512Crypt } from './crypt';
import { prefixToNetmask, renderTemplate, TemplateError, templateVariables, type InstallVars } from './template';

describe('sha512-crypt', () => {
  // Test vectors from Ulrich Drepper's "Unix crypt using SHA-256 and SHA-512" specification.
  it('matches the specification vectors', () => {
    expect(sha512Crypt('Hello world!', 'saltstring')).toBe('$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1');
    expect(sha512Crypt('Hello world!', 'saltstringsaltstring', 10000)).toBe('$6$rounds=10000$saltstringsaltst$OW1/O6BYHV6BcXZu8QVeXbDWra3Oeqh0sbHbbMCVNSnCM/UrjmM0Dp8vOuZeHBy/YTBmSK6H9qs/y3RnOaw5v.');
    expect(sha512Crypt('This is just a test', 'toolongsaltstring', 5000)).toBe('$6$rounds=5000$toolongsaltstrin$lQ8jolhgVRVhY4b5pZKaysCLi0QBxGoNeKQzQ3glMhwllF7oGDZxUhx1yxdYcz/e1JSbq3y6JMxxl8audkUEm0');
    expect(sha512Crypt('a very much longer text to encrypt.  This one even stretches over morethan one line.', 'anotherlongsaltstring', 1400)).toBe(
      '$6$rounds=1400$anotherlongsalts$POfYwTEok97VWcjxIiSOjiykti.o/pQs.wPvMxQ6Fm7I6IoYN3CmLs66x9t0oSwbtEW7o7UmJEiDwGqd8p4ur1',
    );
    expect(sha512Crypt('we have a short salt string but not a short password', 'short', 77777)).toBe(
      '$6$rounds=77777$short$WuQyW2YR.hBNpjjRhpYD/ifIw05xdfeEyQoMxIXbkvr0gge1a1x3yRULJ5CCaUeOxFmtlcGZelFl5CxtgfiAc0',
    );
  });

  it('uses a random salt by default', () => {
    const a = sha512Crypt('same password');
    const b = sha512Crypt('same password');
    expect(a).toMatch(/^\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}$/);
    expect(a).not.toBe(b);
  });
});

describe('install templates', () => {
  const vars = { hostname: 'web-01.example.net', shortname: 'web-01', ip: '203.0.113.10', static: 'yes', dhcp: '', sshKeys: '' } as unknown as InstallVars;

  it('substitutes variables and conditional blocks', () => {
    expect(renderTemplate('network --hostname={{hostname}}{{#if static}} --ip={{ip}}{{/if}}{{#if dhcp}} --bootproto=dhcp{{/if}}', vars)).toBe('network --hostname=web-01.example.net --ip=203.0.113.10');
  });

  it('rejects unknown variables and unbalanced blocks', () => {
    expect(() => renderTemplate('{{hostnme}}', vars)).toThrow(TemplateError);
    expect(() => renderTemplate('{{#if static}}x', vars)).toThrow(/Unbalanced/);
    expect(templateVariables('{{a}} {{#if b}}{{c}}{{/if}}').sort()).toEqual(['a', 'b', 'c']);
  });

  it('converts prefix lengths to netmasks', () => {
    expect(prefixToNetmask(24)).toBe('255.255.255.0');
    expect(prefixToNetmask(29)).toBe('255.255.255.248');
    expect(prefixToNetmask(32)).toBe('255.255.255.255');
  });
});
