import { useState, type FormEvent } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { PASSWORD_MIN_LENGTH } from '@crapplet/shared';
import { api, qs, type Paginated } from '../lib/api';
import { useAuth } from '../lib/auth';
import { relativeTime } from '../lib/format';
import type { Customer, RoleRow, UserRow } from '../lib/types';
import { Button, Chip, ConfirmDialog, EmptyState, ErrorNote, Field, Input, Loading, Modal, PageHeader, Pagination, Panel, Select, Table } from '../components/ui';

function useRoles() {
  return useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleRow[]>('/roles') });
}
function useCustomerOptions(enabled: boolean) {
  return useQuery({ queryKey: ['customers', 'options'], queryFn: () => api.get<Paginated<Customer>>('/customers?pageSize=200'), enabled });
}

function RolePicker({ scope, value, onChange }: { scope: 'staff' | 'customer'; value: string[]; onChange: (v: string[]) => void }) {
  const roles = useRoles();
  const { me } = useAuth();
  const mine = new Set(me?.permissions ?? []);
  const options = (roles.data ?? []).filter((r) => r.scope === scope);
  return (
    <fieldset>
      <legend className="mb-1 text-[13px] font-medium text-ink-2">Roles</legend>
      <ErrorNote error={roles.error} />
      <div className="flex flex-col divide-y divide-rule rounded-lg border border-rule bg-sunken">
        {options.map((r) => {
          const grantable = r.permissions.every((p) => mine.has(p as never));
          return (
            <label key={r.id} className={`flex items-start gap-2.5 px-3 py-2 ${grantable ? 'cursor-pointer' : 'opacity-55'}`}>
              <input
                type="checkbox"
                className="mt-1 accent-[var(--accent)]"
                checked={value.includes(r.id)}
                disabled={!grantable}
                onChange={(e) => onChange(e.target.checked ? [...value, r.id] : value.filter((x) => x !== r.id))}
              />
              <span>
                <span className="font-medium">{r.name}</span>
                <span className="block text-[12.5px] text-ink-3">{grantable ? r.description || `${r.permissions.length} permissions` : 'Grants permissions you don’t hold'}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function CreateUser({ onClose, presetCustomer }: { onClose: () => void; presetCustomer?: string }) {
  const qc = useQueryClient();
  const [userType, setUserType] = useState<'staff' | 'customer'>(presetCustomer ? 'customer' : 'staff');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [customerId, setCustomerId] = useState(presetCustomer ?? '');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const customers = useCustomerOptions(userType === 'customer');
  const m = useMutation({
    mutationFn: () => api.post<UserRow>('/users', { email, name, password, userType, customerId: userType === 'customer' ? customerId : null, roleIds }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
  });
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <fieldset className="flex gap-4">
        <legend className="mb-1 text-[13px] font-medium text-ink-2">Account type</legend>
        {(['staff', 'customer'] as const).map((t) => (
          <label key={t} className="flex items-center gap-1.5">
            <input type="radio" name="userType" className="accent-[var(--accent)]" checked={userType === t} onChange={() => { setUserType(t); setRoleIds([]); }} />
            {t === 'staff' ? 'Crapplet staff' : 'Customer portal'}
          </label>
        ))}
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name">{(id) => <Input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Email">{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      </div>
      {userType === 'customer' && (
        <Field label="Customer">
          {(id) => (
            <Select id={id} required value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">Choose a customer</option>
              {customers.data?.items.filter((c) => c.status !== 'closed').map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.code})
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <Field label="Temporary password" hint={`At least ${PASSWORD_MIN_LENGTH} characters. Share it securely; the user can change it after signing in.`}>
        {(id, d) => <Input id={id} aria-describedby={d} type="text" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} className="font-mono" />}
      </Field>
      <RolePicker scope={userType} value={roleIds} onChange={setRoleIds} />
      <ErrorNote error={m.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={m.isPending} disabled={!roleIds.length || password.length < PASSWORD_MIN_LENGTH || (userType === 'customer' && !customerId)}>
          Create user
        </Button>
      </div>
    </form>
  );
}

function EditUser({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const qc = useQueryClient();
  const { me, can } = useAuth();
  const self = me?.user.id === user.id;
  const [name, setName] = useState(user.name);
  const [status, setStatus] = useState(user.status);
  const [roleIds, setRoleIds] = useState(user.roles.map((r) => r.id));
  const [confirm, setConfirm] = useState<'sessions' | 'mfa' | null>(null);
  const invalidate = () => qc.invalidateQueries({ queryKey: ['users'] });
  const save = useMutation({
    mutationFn: () => {
      const rolesChanged = roleIds.slice().sort().join() !== user.roles.map((r) => r.id).sort().join();
      return api.patch<UserRow>(`/users/${user.id}`, {
        ...(name !== user.name && { name }),
        ...(status !== user.status && { status }),
        ...(rolesChanged && { roleIds }),
      });
    },
    onSuccess: async () => {
      await invalidate();
      onClose();
    },
  });
  const revoke = useMutation({
    mutationFn: () => api.post<{ revoked: number }>(`/users/${user.id}/revoke-sessions`),
    onSuccess: async () => {
      setConfirm(null);
      await invalidate();
    },
  });
  const resetMfa = useMutation({
    mutationFn: () => api.post(`/users/${user.id}/reset-mfa`),
    onSuccess: async () => {
      setConfirm(null);
      await invalidate();
      onClose();
    },
  });
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ink-2">
        {user.email}
        {user.customerName && <> — portal user for {user.customerName}</>}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Status" hint={self ? 'You can’t disable your own account.' : undefined}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={status} disabled={self} onChange={(e) => setStatus(e.target.value as UserRow['status'])}>
              <option value="active">Active</option>
              <option value="disabled">Disabled (signs out everywhere)</option>
            </Select>
          )}
        </Field>
      </div>
      {self ? <p className="text-[13px] text-ink-3">You can’t change your own roles. Ask another administrator.</p> : <RolePicker scope={user.userType} value={roleIds} onChange={setRoleIds} />}
      <ErrorNote error={save.error} />
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-4">
        <div className="flex flex-wrap gap-2">
          {can('users.sessions.revoke') && (
            <Button type="button" size="sm" onClick={() => setConfirm('sessions')}>
              Sign out everywhere
            </Button>
          )}
          {can('users.sessions.revoke') && user.mfaEnabled && !self && (
            <Button type="button" size="sm" onClick={() => setConfirm('mfa')}>
              Reset two-step sign-in
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={save.isPending} disabled={!roleIds.length} onClick={() => save.mutate()}>
            Save changes
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirm === 'sessions'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Sign ${user.name} out everywhere?`}
        body="Every active session for this user ends immediately. They can sign in again with their password."
        confirmLabel="Sign out everywhere"
        busy={revoke.isPending}
        error={revoke.error}
        onConfirm={() => revoke.mutate()}
      />
      <ConfirmDialog
        open={confirm === 'mfa'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Reset two-step sign-in for ${user.name}?`}
        body="Use this only after confirming the person’s identity, for example when they lost their phone. Their authenticator and recovery codes stop working and they are signed out."
        confirmLabel="Reset two-step sign-in"
        busy={resetMfa.isPending}
        error={resetMfa.error}
        onConfirm={() => resetMfa.mutate()}
      />
    </div>
  );
}

export function UsersPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page') ?? 1);
  const q = params.get('q') ?? '';
  const userType = params.get('userType') ?? '';
  const customerId = params.get('customerId') ?? '';
  const [search, setSearch] = useState(q);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);

  const list = useQuery({
    queryKey: ['users', { page, q, userType, customerId }],
    queryFn: () => api.get<Paginated<UserRow>>(`/users${qs({ page, pageSize: 25, q, userType, customerId })}`),
    placeholderData: keepPreviousData,
  });
  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="Users and permissions"
        description="Staff accounts and customer portal accounts. Roles decide what each person can see and do."
        actions={
          <>
            {can('roles.read') && (
              <Link to="/roles" className="inline-flex h-9 items-center rounded-lg border border-rule-strong bg-field px-3.5 font-medium hover:bg-panel">
                Manage roles
              </Link>
            )}
            {can('users.write') && <Button variant="primary" onClick={() => setCreating(true)}>Add user</Button>}
          </>
        }
      />
      <Panel flush>
        <form
          role="search"
          className="flex flex-wrap gap-2 border-b border-rule p-3"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: search.trim(), page: '' });
          }}
        >
          <label className="sr-only" htmlFor="user-search">Search users</label>
          <Input id="user-search" placeholder="Search name or email" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
          <label className="sr-only" htmlFor="user-type">Account type</label>
          <Select id="user-type" className="w-56" value={userType} onChange={(e) => update({ userType: e.target.value, page: '' })}>
            <option value="">Staff and customers</option>
            <option value="staff">Staff only</option>
            <option value="customer">Customer portal only</option>
          </Select>
          <Button type="submit">Search</Button>
          {customerId && (
            <Button type="button" variant="ghost" onClick={() => update({ customerId: '', page: '' })}>
              Clear customer filter
            </Button>
          )}
        </form>
        {list.isLoading && <Loading />}
        <ErrorNote error={list.error} className="m-4" />
        {list.data && list.data.items.length === 0 && <EmptyState title="No users match">Try a different search or filter.</EmptyState>}
        {list.data && list.data.items.length > 0 && (
          <>
            <Table label="Users">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Account</th>
                  <th>Roles</th>
                  <th>Two-step</th>
                  <th>Status</th>
                  <th>Last sign-in</th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((u) => (
                  <tr key={u.id} className="hover:bg-sunken/50">
                    <td>
                      {can('users.write') ? (
                        <button className="text-left font-medium text-accent hover:underline" onClick={() => setEditing(u)}>
                          {u.name}
                        </button>
                      ) : (
                        <span className="font-medium">{u.name}</span>
                      )}
                      <span className="block text-[12.5px] text-ink-3">{u.email}</span>
                    </td>
                    <td className="text-ink-2">{u.userType === 'staff' ? 'Staff' : u.customerName}</td>
                    <td className="text-ink-2">{u.roles.map((r) => r.name).join(', ')}</td>
                    <td>{u.mfaEnabled ? <Chip tone="ok">On</Chip> : <Chip tone={u.userType === 'staff' ? 'warn' : 'neutral'}>Off</Chip>}</td>
                    <td>
                      {u.status === 'disabled' ? <Chip>Disabled</Chip> : u.locked ? <Chip tone="crit" title="Too many failed sign-ins; unlocks automatically">Locked</Chip> : <Chip tone="ok">Active</Chip>}
                    </td>
                    <td className="text-ink-2">{relativeTime(u.lastLoginAt)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(p) => update({ page: String(p) })} />
          </>
        )}
      </Panel>
      <Modal wide open={creating} onOpenChange={setCreating} title="Add user">
        {creating && <CreateUser onClose={() => setCreating(false)} presetCustomer={customerId || undefined} />}
      </Modal>
      <Modal wide open={!!editing} onOpenChange={(o) => !o && setEditing(null)} title={editing ? `Edit ${editing.name}` : ''}>
        {editing && <EditUser user={editing} onClose={() => setEditing(null)} />}
      </Modal>
    </>
  );
}
