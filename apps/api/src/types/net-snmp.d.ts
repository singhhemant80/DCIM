// Minimal typings for the parts of net-snmp used here (the package ships none).
declare module 'net-snmp' {
  export interface Varbind {
    oid: string;
    type: number;
    value: unknown;
  }
  export interface Session {
    get(oids: string[], cb: (err: Error | null, varbinds: Varbind[]) => void): void;
    subtree(oid: string, maxRepetitions: number, feed: (varbinds: Varbind[]) => boolean | void, done: (err: Error | null) => void): void;
    close(): void;
    on(event: 'error', cb: (err: Error) => void): void;
  }
  export const Version1: number;
  export const Version2c: number;
  export const Version3: number;
  export const SecurityLevel: Record<string, number>;
  export const AuthProtocols: Record<string, number>;
  export const PrivProtocols: Record<string, number>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const ObjectType: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const MibProviderType: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const MaxAccess: any;
  export function isVarbindError(vb: Varbind): boolean;
  export function varbindError(vb: Varbind): string;
  export function createSession(target: string, community: string, options?: Record<string, unknown>): Session;
  export function createV3Session(target: string, user: Record<string, unknown>, options?: Record<string, unknown>): Session;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function createAgent(options: Record<string, unknown>, cb: (err: Error | null, data: unknown) => void, mib?: unknown): any;
}
