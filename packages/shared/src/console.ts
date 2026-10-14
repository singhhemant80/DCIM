import { z } from 'zod';

/** In-app consoles: a graphical one over the BMC's VNC service, and a text one over IPMI Serial-over-LAN. */
export const CONSOLE_KINDS = ['vnc', 'sol'] as const;
export type ConsoleKind = (typeof CONSOLE_KINDS)[number];
export const CONSOLE_LABELS: Record<ConsoleKind, string> = { vnc: 'Graphical console (VNC)', sol: 'Serial console (SOL)' };

const host = z.string().trim().min(1).max(255).nullable().optional();

/** Console access, stored encrypted and never returned. Host empty: the device's management address. */
export const consoleCredentialSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('vnc'),
    host,
    port: z.number().int().min(1).max(65535).default(5901),
    /** The BMC's VNC server password (iDRAC: iDRAC Settings → Services → VNC Server). */
    password: z.string().min(1).max(64),
  }),
  z.object({
    kind: z.literal('sol'),
    host,
    port: z.number().int().min(1).max(65535).default(623),
    username: z.string().trim().min(1).max(64),
    password: z.string().min(1).max(256),
    privilege: z.enum(['USER', 'OPERATOR', 'ADMINISTRATOR']).default('ADMINISTRATOR'),
  }),
  z.object({
    kind: z.literal('web'),
    /** The BMC's web interface, e.g. https://10.0.0.21. */
    url: z
      .string()
      .trim()
      .url()
      .max(300)
      .refine((u) => /^https?:\/\//i.test(u), 'Use an http(s) address'),
  }),
]);
export type ConsoleCredentialInput = z.infer<typeof consoleCredentialSchema>;

export const consoleSessionSchema = z.object({ kind: z.enum(CONSOLE_KINDS) });
