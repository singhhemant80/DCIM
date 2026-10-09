import { runMigrations } from '../db/db';
import { syncLifecycleDefaults, syncSystemRoles } from '../roles/provision';
import { organizations } from '../db/schema';
import { fail, withDb } from './common';

/**
 * Applies pending migrations (each in a transaction, tracked in
 * drizzle.__drizzle_migrations) and then refreshes built-in roles for every
 * organization so permission changes ship with upgrades.
 */
withDb(async (db) => {
  await runMigrations(db);
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  for (const o of orgs) {
    await syncSystemRoles(db, o.id);
    await syncLifecycleDefaults(db, o.id);
  }
  process.stdout.write(`Migrations applied. System roles synced for ${orgs.length} organization(s).\n`);
}).catch(fail);
