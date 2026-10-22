import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { BmcSetupInput, Permission } from '@crapplet/shared';
import { DB, type Db } from '../db/db';
import { consoleCredentials, controlCredentials, deviceCredentials, deviceHardware, devices, powerMonitoring, serverHealth } from '../db/schema';
import { hasPermission, type Principal, type RequestMeta } from '../auth/principal';
import { CredentialsService } from '../network/credentials.service';
import { PowerService } from '../power/power.service';
import { ProvisioningService } from '../provisioning/provisioning.service';
import { ConsoleService } from '../console/console.service';
import { ownDevice } from '../network/common';

type Use = 'monitoring' | 'power' | 'control' | 'serialConsole' | 'vnc';
export interface BmcUseResult {
  use: Use;
  status: 'set' | 'skipped' | 'failed';
  message?: string;
}

/**
 * A server's BMC entered once — address and login — and stored for every use
 * that needs it: the read-only monitoring credential (hardware inventory,
 * current health, power readings), and only when asked, power control and
 * the consoles. Each use stays its own encrypted credential under its own
 * permission, through the same services (and audit records) as when set up
 * one by one; a use the caller may not set up is reported as skipped.
 */
@Injectable()
export class BmcService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly creds: CredentialsService,
    private readonly power: PowerService,
    private readonly provisioning: ProvisioningService,
    private readonly console: ConsoleService,
  ) {}

  async status(p: Principal, id: string) {
    const d = await ownDevice(this.db, p, id);
    const [cs, [pm], [hw], [sh], [ctl], cons] = await Promise.all([
      this.db
        .select()
        .from(deviceCredentials)
        .where(and(eq(deviceCredentials.deviceId, id), inArray(deviceCredentials.kind, ['redfish', 'ipmi']))),
      this.db.select().from(powerMonitoring).where(eq(powerMonitoring.deviceId, id)),
      this.db.select({ at: deviceHardware.fetchedAt, error: deviceHardware.lastError, status: deviceHardware.status }).from(deviceHardware).where(eq(deviceHardware.deviceId, id)),
      this.db.select({ at: serverHealth.at, error: serverHealth.lastError, attempt: serverHealth.lastAttemptAt }).from(serverHealth).where(eq(serverHealth.deviceId, id)),
      this.db.select().from(controlCredentials).where(eq(controlCredentials.deviceId, id)),
      this.db.select({ kind: consoleCredentials.kind, host: consoleCredentials.host, username: consoleCredentials.username }).from(consoleCredentials).where(eq(consoleCredentials.deviceId, id)),
    ]);
    const mon = cs.find((c) => c.kind === 'redfish') ?? cs.find((c) => c.kind === 'ipmi') ?? null;
    return {
      deviceId: d.id,
      type: d.mgmtType,
      host: mon?.host ?? ctl?.host ?? d.mgmtAddress ?? null,
      configured: !!mon,
      monitoring: mon ? { kind: mon.kind, host: mon.host, port: mon.port, username: mon.username, verifyTls: mon.params.verifyTls ?? null, rotatedAt: mon.rotatedAt } : null,
      power: pm ? { enabled: pm.enabled, kind: pm.credentialKind, lastOkAt: pm.lastOkAt, lastWatts: pm.lastWatts, lastError: pm.lastError } : null,
      hardware: hw ? { at: hw.at, error: hw.status === 'failed' ? hw.error : null } : null,
      health: sh ? { at: sh.at, error: sh.error } : null,
      control: ctl ? { kind: ctl.kind, host: ctl.host, username: ctl.username, sameLogin: !!mon && ctl.username === mon.username && ctl.host === mon.host, rotatedAt: ctl.rotatedAt } : null,
      console: { sol: cons.some((c) => c.kind === 'sol'), vnc: cons.some((c) => c.kind === 'vnc') },
    };
  }

  async setup(p: Principal, id: string, input: BmcSetupInput, meta: RequestMeta) {
    const d = await ownDevice(this.db, p, id);
    const lacks = (...perms: Permission[]) => perms.find((x) => !hasPermission(p, x));
    const kind = input.type === 'ipmi' ? 'ipmi' : 'redfish';
    const host = input.host.trim();
    const results: BmcUseResult[] = [];
    const step = async (use: Use, perms: Permission[], run: () => Promise<unknown>) => {
      const missing = lacks(...perms);
      if (missing) return results.push({ use, status: 'skipped', message: `Needs the ${missing} permission` });
      try {
        await run();
        results.push({ use, status: 'set' });
      } catch (e) {
        const r = (e as { getResponse?: () => unknown }).getResponse?.() as { message?: string } | undefined;
        results.push({ use, status: 'failed', message: String(r?.message ?? (e as Error).message ?? 'Failed').slice(0, 300) });
      }
    };

    // Monitoring (read-only): hardware, current health, power readings. Required.
    if (lacks('monitoring.configure')) throw new BadRequestException({ error: 'forbidden', message: 'Setting up a BMC needs the monitoring.configure permission' });
    const ro = input.readOnly ?? { username: input.username, password: input.password };
    await this.creds.put(
      p,
      id,
      kind === 'redfish'
        ? { kind, host, port: input.port ?? null, username: ro.username, password: ro.password, scheme: 'https', verifyTls: input.verifyTls, timeoutMs: 10_000 }
        : { kind, host, port: input.port ?? null, username: ro.username.slice(0, 16), password: ro.password, ipmiPrivilege: 'USER', timeoutMs: 10_000, retries: 1 },
      meta,
    );
    results.push({ use: 'monitoring', status: 'set' });

    // The BMC address is the management address (pinged on the Health page).
    if (d.mgmtAddress?.trim() !== host || d.mgmtType !== input.type) await this.db.update(devices).set({ mgmtAddress: host, mgmtType: input.type }).where(eq(devices.id, id));

    // Read the BMC soon instead of on the next schedule.
    await this.db.execute(
      sql`insert into device_hardware (device_id, org_id, requested_at, requested_by) values (${id}, ${p.orgId}, now(), ${p.email}) on conflict (device_id) do update set requested_at = now(), requested_by = excluded.requested_by`,
    );
    await this.db.execute(sql`update server_health set next_at = now() where device_id = ${id}`);

    await step('power', ['power.configure'], () => this.power.configurePolling(p, id, { enabled: input.power, credentialKind: kind, intervalSeconds: 60 }, meta));
    if (input.control)
      await step('control', ['provisioning.execute'], () =>
        this.provisioning.putControlCredential(
          p,
          id,
          kind === 'redfish'
            ? { kind, host, port: input.port ?? null, username: input.username, password: input.password, scheme: 'https', verifyTls: input.verifyTls, timeoutMs: 15_000 }
            : { kind, host, port: input.port ?? null, username: input.username, password: input.password, ipmiPrivilege: 'OPERATOR', timeoutMs: 10_000 },
          meta,
        ),
      );
    if (input.serialConsole)
      await step('serialConsole', ['hardware.console', 'provisioning.execute'], () =>
        this.console.putCredential(p, id, { kind: 'sol', host, port: 623, username: input.username, password: input.password, privilege: 'ADMINISTRATOR' }, meta),
      );
    if (input.vncPassword) await step('vnc', ['hardware.console', 'provisioning.execute'], () => this.console.putCredential(p, id, { kind: 'vnc', host, port: 5901, password: input.vncPassword! }, meta));

    return { results, status: await this.status(p, id) };
  }
}
