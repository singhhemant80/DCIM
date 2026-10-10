import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/db';
import { customers } from '../db/schema';
import type { Principal } from '../auth/principal';

/**
 * The customer a request is for. Customers always act for themselves (naming
 * another customer is refused); staff must name an active customer of their
 * organization.
 */
export async function customerFor(db: DbOrTx, p: Principal, requested: string | null | undefined, opts: { required: boolean } = { required: true }): Promise<string | null> {
  if (p.userType !== 'staff') {
    if (!p.customerId) throw new ForbiddenException({ error: 'forbidden', message: 'No customer account' });
    if (requested && requested !== p.customerId) throw new ForbiddenException({ error: 'forbidden', message: 'You can only act for your own account' });
    return p.customerId;
  }
  if (!requested) {
    if (opts.required) throw new BadRequestException({ error: 'customer_required', message: 'Choose the customer' });
    return null;
  }
  const [c] = await db.select({ id: customers.id, status: customers.status }).from(customers).where(and(eq(customers.id, requested), eq(customers.orgId, p.orgId)));
  if (!c) throw new BadRequestException({ error: 'invalid_customer', message: 'Customer does not exist' });
  if (c.status !== 'active') throw new BadRequestException({ error: 'customer_inactive', message: 'The customer is not active' });
  return c.id;
}

/**
 * Who may file requests (cross-connects, shipments, visits): staff with
 * `services.write`, or customer users with `tickets.write` for their own account.
 */
export function assertCanRequest(p: Principal) {
  const ok = p.userType === 'staff' ? p.permissions.has('services.write') : p.permissions.has('tickets.write');
  if (!ok) throw new ForbiddenException({ error: 'forbidden', message: 'You do not have permission to perform this action' });
}

export function assertStaffWrite(p: Principal) {
  if (p.userType !== 'staff' || !p.permissions.has('services.write')) throw new ForbiddenException({ error: 'forbidden', message: 'You do not have permission to perform this action' });
}

/** 404 rather than 403 for another customer's rows, so ids can't be probed. */
export function visibleTo(p: Principal, row: { orgId: string; customerId: string | null } | undefined, what: string) {
  if (!row || row.orgId !== p.orgId || (p.userType !== 'staff' && (row.customerId === null || row.customerId !== p.customerId))) throw new NotFoundException({ error: 'not_found', message: `${what} not found` });
}

export function transitionAllowed<S extends string>(map: Record<S, readonly S[]>, from: S, to: S, label: string) {
  if (from === to) return;
  if (!map[from]?.includes(to)) throw new BadRequestException({ error: 'invalid_transition', message: `${label} can't go from ${from.replace(/_/g, ' ')} to ${to.replace(/_/g, ' ')}` });
}
