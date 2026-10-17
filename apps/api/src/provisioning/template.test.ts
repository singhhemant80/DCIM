import { describe, expect, it } from 'vitest';
import { DEFAULT_TEMPLATES } from '@crapplet/shared';
import { renderTemplate, templateVariables, TEMPLATE_VARIABLES, type InstallVars } from './template';

const base: InstallVars = {
  hostname: 'node-01.example.net',
  shortname: 'node-01',
  domain: 'example.net',
  networkMode: 'dhcp',
  static: '',
  dhcp: 'yes',
  ip: '',
  prefix: '',
  netmask: '',
  gateway: '',
  nameservers: '',
  nameserversCsv: '',
  mac: '52:54:00:10:20:30',
  rootPasswordHash: '$6$salt$hash',
  noPassword: '',
  sshKeys: 'ssh-ed25519 AAAA ops@example',
  sshKeysJson: '["ssh-ed25519 AAAA ops@example"]',
  sshKeysBase64: Buffer.from('ssh-ed25519 AAAA ops@example\n').toString('base64'),
  callbackUrl: 'http://10.0.0.5/api/v1/boot/callback/tok',
  configUrl: 'http://10.0.0.5/api/v1/boot/config/tok',
  jobId: 'job',
  imageName: 'Image',
};
const staticNet = { ...base, networkMode: 'static', static: 'yes', dhcp: '', ip: '10.20.0.40', prefix: '24', netmask: '255.255.255.0', gateway: '10.20.0.1', nameservers: '1.1.1.1 9.9.9.9', nameserversCsv: '1.1.1.1,9.9.9.9' };

describe('templates', () => {
  it('{{#if}} blocks nest', () => {
    const v = { ...base, a: 'yes', b: '', c: 'x' } as InstallVars;
    expect(renderTemplate('[{{#if a}}A{{#if b}}B{{/if}}{{#if c}}C{{c}}{{/if}}{{/if}}]{{#if b}}no{{/if}}', v)).toBe('[ACx]');
    expect(() => renderTemplate('{{#if a}}x', { ...base, a: 'y' } as InstallVars)).toThrow(/Unbalanced/);
  });

  for (const [kind, t] of Object.entries(DEFAULT_TEMPLATES)) {
    it(`default ${kind} template uses only known variables and renders for DHCP and static, with or without a password`, () => {
      expect(templateVariables(t!.template).filter((v) => !(TEMPLATE_VARIABLES as readonly string[]).includes(v))).toEqual([]);
      for (const v of [base, staticNet, { ...base, rootPasswordHash: '', noPassword: 'yes' }, { ...staticNet, gateway: '' }]) {
        const out = renderTemplate(t!.template, v);
        expect(out).not.toMatch(/\{\{/);
        expect(out).toContain(v.callbackUrl);
        // Debian gets a static address on the kernel line instead (it needs it before fetching the preseed).
        if (v.static && kind !== 'debian') expect(out).toContain('10.20.0.40');
      }
    });
  }

  it('Ubuntu autoinstall renders to the expected YAML shape for a static address', () => {
    const out = renderTemplate(DEFAULT_TEMPLATES.ubuntu!.template, staticNet);
    expect(out).toContain('        addresses: ["10.20.0.40/24"]\n        routes:\n          - to: default\n            via: "10.20.0.1"\n        nameservers:\n          addresses: [1.1.1.1,9.9.9.9]\n  storage:');
    expect(out).toContain('allow-pw: true');
    expect(out).toContain('lock_passwd: false');
  });
});
