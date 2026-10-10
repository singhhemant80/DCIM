/**
 * Unattended-install templates. A template is plain text with {{variable}}
 * placeholders and optional {{#if variable}} … {{/if}} blocks (no loops, no
 * expressions, no code). Unknown variables are an error, so a typo in a
 * template fails the job up front instead of producing a broken install.
 */
export interface InstallVars {
  hostname: string;
  shortname: string;
  domain: string;
  /** "dhcp" or "static". */
  networkMode: string;
  ip: string;
  prefix: string;
  netmask: string;
  gateway: string;
  nameservers: string;
  nameserversCsv: string;
  mac: string;
  rootPasswordHash: string;
  sshKeys: string;
  sshKeysJson: string;
  callbackUrl: string;
  configUrl: string;
  jobId: string;
  imageName: string;
  [k: string]: string;
}

const VAR = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;
const IF = /\{\{#if\s+([a-zA-Z][a-zA-Z0-9]*)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g;

export class TemplateError extends Error {}

export function renderTemplate(template: string, vars: InstallVars): string {
  const check = (name: string) => {
    if (!(name in vars)) throw new TemplateError(`Unknown template variable {{${name}}}`);
  };
  const withIfs = template.replace(IF, (_m, name: string, body: string) => {
    check(name);
    return vars[name] ? body : '';
  });
  if (/\{\{[#/]/.test(withIfs)) throw new TemplateError('Unbalanced {{#if}} / {{/if}} in the template');
  return withIfs.replace(VAR, (_m, name: string) => {
    check(name);
    return vars[name]!;
  });
}

/** Lists the variables a template uses (for validation when an image is saved). */
export function templateVariables(template: string): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(VAR)) out.add(m[1]!);
  for (const m of template.matchAll(IF)) out.add(m[1]!);
  return [...out];
}

export const TEMPLATE_VARIABLES = [
  'hostname',
  'shortname',
  'domain',
  'networkMode',
  'ip',
  'prefix',
  'netmask',
  'gateway',
  'nameservers',
  'nameserversCsv',
  'mac',
  'rootPasswordHash',
  'sshKeys',
  'sshKeysJson',
  'callbackUrl',
  'configUrl',
  'jobId',
  'imageName',
  'static',
  'dhcp',
] as const;

export function prefixToNetmask(prefix: number): string {
  const m = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return [24, 16, 8, 0].map((s) => (m >>> s) & 255).join('.');
}
