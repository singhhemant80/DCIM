import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { PermissionDef, RoleRow } from '../lib/types';
import { Button, Chip, ConfirmDialog, ErrorNote, Field, Input, Loading, Modal, PageHeader, Panel, Select, Table, Textarea } from '../components/ui';

function RoleEditor({ role, onClose }: { role?: RoleRow; onClose: () => void }) {
  const qc = useQueryClient();
  const { can } = useAuth();
  const catalog = useQuery({ queryKey: ['permission-catalog'], queryFn: () => api.get<PermissionDef[]>('/roles/permissions') });
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [scope, setScope] = useState<'staff' | 'customer'>(role?.scope ?? 'staff');
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? []);
  const readOnly = !!role?.system;

  const groups = useMemo(() => {
    const out = new Map<string, PermissionDef[]>();
    for (const p of catalog.data ?? []) {
      if (scope === 'customer' && p.staffOnly) continue;
      out.set(p.group, [...(out.get(p.group) ?? []), p]);
    }
    return [...out];
  }, [catalog.data, scope]);

  const save = useMutation({
    mutationFn: () => {
      const body = { name, description, scope, permissions: perms };
      return role ? api.patch(`/roles/${role.id}`, body) : api.post('/roles', body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['roles'] });
      onClose();
    },
  });

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {readOnly && <p className="rounded-md bg-sunken px-3 py-2 text-[13px] text-ink-2">Built-in roles can’t be changed. Create a custom role to adjust permissions.</p>}
      <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
        <Field label="Role name">{(id) => <Input id={id} required disabled={readOnly} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="For" hint={role ? 'Can’t change after creation.' : undefined}>
          {(id, d) => (
            <Select
              id={id}
              aria-describedby={d}
              disabled={!!role}
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as 'staff' | 'customer');
                setPerms([]);
              }}
            >
              <option value="staff">Staff users</option>
              <option value="customer">Customer portal users</option>
            </Select>
          )}
        </Field>
      </div>
      <Field label="Description">{(id) => <Textarea id={id} disabled={readOnly} value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-14" />}</Field>
      {catalog.isLoading && <Loading label="Loading permissions" />}
      <ErrorNote error={catalog.error} />
      <div className="flex flex-col gap-3">
        {groups.map(([group, list]) => (
          <fieldset key={group} className="rounded-xl border border-rule bg-sunken">
            <legend className="ml-2 px-1 text-[13px] font-semibold">{group}</legend>
            <div className="grid gap-x-4 px-3 pt-1 pb-2 sm:grid-cols-2">
              {list.map((p) => {
                const held = can(p.key as never);
                return (
                  <label key={p.key} className={`flex items-start gap-2 py-1 ${readOnly || !held ? 'opacity-60' : 'cursor-pointer'}`} title={!held ? 'You can’t grant a permission you don’t hold' : undefined}>
                    <input
                      type="checkbox"
                      className="mt-1 accent-[var(--accent)]"
                      disabled={readOnly || !held}
                      checked={perms.includes(p.key)}
                      onChange={(e) => setPerms(e.target.checked ? [...perms, p.key] : perms.filter((x) => x !== p.key))}
                    />
                    <span>
                      {p.label}
                      {p.dangerous && (
                        <span className="ml-1.5">
                          <Chip tone="warn">Sensitive</Chip>
                        </span>
                      )}
                      <span className="block font-mono text-[11.5px] text-ink-3">{p.key}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
      <ErrorNote error={save.error} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          {readOnly ? 'Close' : 'Cancel'}
        </Button>
        {!readOnly && (
          <Button type="submit" variant="primary" busy={save.isPending}>
            {role ? 'Save role' : 'Create role'}
          </Button>
        )}
      </div>
    </form>
  );
}

export function RolesPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleRow[]>('/roles') });
  const [editing, setEditing] = useState<RoleRow | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RoleRow | null>(null);
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/roles/${id}`),
    onSuccess: async () => {
      setDeleting(null);
      await qc.invalidateQueries({ queryKey: ['roles'] });
    },
  });

  return (
    <>
      <PageHeader
        title="Roles"
        description="Built-in roles cover common jobs. Custom roles let you grant exactly the permissions someone needs. Customer roles can never include staff-only permissions."
        actions={can('roles.write') && <Button variant="primary" onClick={() => setEditing('new')}>Create role</Button>}
      />
      <Panel flush>
        {roles.isLoading && <Loading />}
        <ErrorNote error={roles.error} className="m-4" />
        {roles.data && (
          <Table label="Roles">
            <thead>
              <tr>
                <th>Role</th>
                <th>For</th>
                <th>Permissions</th>
                <th>Members</th>
                <th className="sr-only">Actions</th>
              </tr>
            </thead>
            <tbody>
              {roles.data.map((r) => (
                <tr key={r.id} className="hover:bg-sunken/50">
                  <td>
                    <button className="text-left font-medium text-accent hover:underline" onClick={() => setEditing(r)}>
                      {r.name}
                    </button>
                    {r.system && <span className="ml-2"><Chip>Built-in</Chip></span>}
                    <span className="block max-w-[60ch] text-[12.5px] text-ink-3">{r.description}</span>
                  </td>
                  <td className="text-ink-2">{r.scope === 'staff' ? 'Staff' : 'Customers'}</td>
                  <td>{r.permissions.length}</td>
                  <td>{r.members}</td>
                  <td className="text-right">
                    {!r.system && can('roles.write') && (
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(r)}>
                        Delete
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
      <Modal wide open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} title={editing === 'new' ? 'Create role' : editing ? editing.name : ''}>
        {editing !== null && <RoleEditor role={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      </Modal>
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete the ${deleting?.name} role?`}
        body={deleting?.members ? `${deleting.members} user(s) still have this role. Reassign them first.` : 'This can’t be undone.'}
        confirmLabel="Delete role"
        busy={del.isPending}
        error={del.error}
        onConfirm={() => deleting && del.mutate(deleting.id)}
      />
    </>
  );
}
