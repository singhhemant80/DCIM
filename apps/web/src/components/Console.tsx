import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CONSOLE_LABELS, type ConsoleKind } from '@crapplet/shared';
import RFB from '@novnc/novnc/core/rfb.js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDateTime, relativeTime } from '../lib/format';
import { Button, Chip, ErrorNote, Field, Input, Modal, Panel, Select, Table } from './ui';

interface ConsoleStatusT {
  web: { url: string | null; configured: boolean } | null;
  vnc: { configured: boolean; host?: string | null; port?: number | null; rotatedAt?: string };
  sol: { configured: boolean; host?: string | null; port?: number | null; username?: string | null; privilege?: string | null; rotatedAt?: string };
  live: { id: string; kind: ConsoleKind; user: string; since: string; mine: boolean }[];
  recent: { id: string; kind: ConsoleKind; user: string; status: string; createdAt: string; connectedAt: string | null; endedAt: string | null; endReason: string | null }[];
}

const wsUrl = (path: string, s: { sessionId: string; ticket: string }) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}?session=${encodeURIComponent(s.sessionId)}&ticket=${encodeURIComponent(s.ticket)}`;

/** Asks the API for a one-time ticket; the browser never holds a console password. */
function useConsoleSession(deviceId: string, kind: ConsoleKind, startPath?: string) {
  const [state, setState] = useState<{ sessionId: string; url: string } | { error: string } | null>(null);
  useEffect(() => {
    let gone = false;
    api
      .post<{ sessionId: string; ticket: string; path: string }>(startPath ?? `/console/devices/${deviceId}/sessions`, { kind })
      // Unmounted meanwhile (dialog closed, or React's development double mount): give the slot back.
      .then((s) => (gone ? endSession(s.sessionId) : setState({ sessionId: s.sessionId, url: wsUrl(s.path, s) })))
      .catch((e: Error) => !gone && setState({ error: e.message }));
    return () => {
      gone = true;
    };
  }, [deviceId, kind, startPath]);
  return state;
}

function endSession(id: string) {
  void api.post(`/console/sessions/${id}/end`).catch(() => undefined);
}

/** Graphical console: noVNC against the relay, which speaks to the BMC's (or, for a VM, the hypervisor's) VNC server. */
export function VncViewer({ deviceId, guestId, onClose }: { deviceId?: string; guestId?: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const session = useConsoleSession(deviceId ?? '', 'vnc', guestId ? `/console/guests/${guestId}/sessions` : undefined);
  const [status, setStatus] = useState('Connecting…');
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!session || 'error' in session || !box.current) return;
    const r = new RFB(box.current, session.url, { wsProtocols: ['binary'] });
    r.scaleViewport = true;
    r.resizeSession = false;
    r.background = '#0b0f17';
    r.addEventListener('connect', () => (setConnected(true), setStatus('Connected')));
    r.addEventListener('securityfailure', (e) => setStatus(`Could not connect: ${(e as CustomEvent<{ reason?: string }>).detail?.reason ?? 'refused'}`));
    r.addEventListener('disconnect', (e) => {
      setConnected(false);
      setStatus((s) => (s.startsWith('Could not') ? s : (e as CustomEvent<{ clean: boolean }>).detail?.clean ? 'Disconnected' : 'Connection lost'));
    });
    rfb.current = r;
    return () => {
      r.disconnect();
      endSession(session.sessionId);
    };
  }, [session]);
  if (session && 'error' in session) return <ErrorNote error={new Error(session.error)} />;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className={connected ? 'size-2 rounded-full bg-ok' : 'size-2 rounded-full bg-ink-3'} aria-hidden />
        <span className="mr-auto">{status}</span>
        <Button size="sm" disabled={!connected} onClick={() => rfb.current?.sendCtrlAltDel()}>
          Ctrl+Alt+Del
        </Button>
        <Button size="sm" disabled={!connected} onClick={() => void box.current?.requestFullscreen?.()}>
          Full screen
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Disconnect
        </Button>
      </div>
      <div ref={box} className="h-[70vh] min-h-[360px] w-full overflow-hidden rounded-lg bg-[#0b0f17]" onClick={() => rfb.current?.focus()} />
      <p className="text-[12px] text-ink-3">Keyboard and mouse go to the {guestId ? 'VM' : 'server'} while the screen has focus. The session ends after 15 minutes without input. Every session is logged.</p>
    </div>
  );
}

/** Serial console: a terminal on Serial-over-LAN. */
function SolTerminal({ deviceId, onClose }: { deviceId: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const session = useConsoleSession(deviceId, 'sol');
  const [status, setStatus] = useState('Connecting…');
  useEffect(() => {
    if (!session || 'error' in session || !box.current) return;
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme: { background: '#0b0f17' }, convertEol: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current);
    fit.fit();
    const ws = new WebSocket(session.url, ['binary']);
    ws.binaryType = 'arraybuffer';
    const enc = new TextEncoder();
    ws.onopen = () => (setStatus('Connected'), term.focus());
    ws.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer));
    ws.onclose = () => setStatus('Disconnected');
    ws.onerror = () => setStatus('Connection failed');
    const sub = term.onData((d) => ws.readyState === ws.OPEN && ws.send(enc.encode(d)));
    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      sub.dispose();
      ws.close();
      term.dispose();
      endSession(session.sessionId);
    };
  }, [session]);
  if (session && 'error' in session) return <ErrorNote error={new Error(session.error)} />;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[13px]">
        <span className="mr-auto">{status}</span>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Disconnect
        </Button>
      </div>
      <div ref={box} className="h-[60vh] min-h-[320px] w-full overflow-hidden rounded-lg bg-[#0b0f17] p-2" />
      <p className="text-[12px] text-ink-3">Serial-over-LAN through the BMC. The server's OS must send its console to the serial port (Linux: console=ttyS1,115200 or as your BMC documents). Type ~. to close from inside the session.</p>
    </div>
  );
}

function SetupForm({ deviceId, kind, onDone }: { deviceId: string; kind: 'vnc' | 'sol' | 'web'; onDone: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ host: '', port: kind === 'vnc' ? '5901' : '623', username: '', password: '', privilege: 'ADMINISTRATOR', url: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () =>
      api.put(
        `/console/devices/${deviceId}/credentials`,
        kind === 'web' ? { kind, url: f.url.trim() } : kind === 'vnc' ? { kind, host: f.host.trim() || null, port: Number(f.port), password: f.password } : { kind, host: f.host.trim() || null, port: Number(f.port), username: f.username.trim(), password: f.password, privilege: f.privilege },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['console', deviceId] });
      onDone();
    },
  });
  return (
    <form
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {kind === 'web' ? (
        <div className="sm:col-span-2">
          <Field label="BMC web address" hint="Opened in a new tab; you sign in to the BMC there">
            {(id, d) => <Input id={id} aria-describedby={d} required placeholder="https://10.0.0.21" value={f.url} onChange={set('url')} className="font-mono" />}
          </Field>
        </div>
      ) : (
        <>
          <Field label="BMC address" hint="Empty: the device's management address">
            {(id, d) => <Input id={id} aria-describedby={d} value={f.host} onChange={set('host')} className="font-mono" />}
          </Field>
          <Field label="Port">{(id) => <Input id={id} type="number" min={1} max={65535} required value={f.port} onChange={set('port')} />}</Field>
          {kind === 'sol' && (
            <>
              <Field label="IPMI user">{(id) => <Input id={id} required value={f.username} onChange={set('username')} />}</Field>
              <Field label="Privilege">
                {(id) => (
                  <Select id={id} value={f.privilege} onChange={set('privilege')}>
                    <option value="ADMINISTRATOR">Administrator</option>
                    <option value="OPERATOR">Operator</option>
                    <option value="USER">User</option>
                  </Select>
                )}
              </Field>
            </>
          )}
          <Field label={kind === 'vnc' ? 'VNC password' : 'IPMI password'} hint={kind === 'vnc' ? 'iDRAC: iDRAC Settings → Services → VNC Server (SSL encryption off)' : 'Stored encrypted; never shown again'}>
            {(id, d) => <Input id={id} aria-describedby={d} type="password" required autoComplete="new-password" value={f.password} onChange={set('password')} />}
          </Field>
        </>
      )}
      <ErrorNote error={save.error} className="sm:col-span-2" />
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" busy={save.isPending}>
          Save encrypted
        </Button>
      </div>
    </form>
  );
}

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'crit' | undefined> = { active: 'ok', connecting: 'warn', pending: 'warn', failed: 'crit' };

/** Remote console for a server: the BMC's own web console, a graphical console and a serial console. */
export function ConsolePanel({ deviceId }: { deviceId: string }) {
  const { me, can } = useAuth();
  const staff = me?.user.userType === 'staff';
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['console', deviceId], queryFn: () => api.get<ConsoleStatusT>(`/console/devices/${deviceId}`), refetchInterval: 15_000 });
  const [open, setOpen] = useState<ConsoleKind | null>(null);
  const [setup, setSetup] = useState<'vnc' | 'sol' | 'web' | null>(null);
  const web = useMutation({
    mutationFn: async () => {
      // Opened before the request so the browser doesn't block it as a pop-up.
      const w = window.open('about:blank', '_blank');
      try {
        const r = await api.post<{ url: string }>(`/console/devices/${deviceId}/web`);
        if (w) {
          w.opener = null;
          w.location.href = r.url;
        }
      } catch (e) {
        w?.close();
        throw e;
      }
    },
  });
  const end = useMutation({ mutationFn: (id: string) => api.post(`/console/sessions/${id}/end`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['console', deviceId] }) });
  const s = q.data;
  if (!s) return q.error ? <ErrorNote error={q.error} /> : null;
  const canSetup = staff && can('provisioning.execute');
  const close = () => {
    setOpen(null);
    setTimeout(() => void qc.invalidateQueries({ queryKey: ['console', deviceId] }), 500);
  };
  return (
    <Panel title="Remote console">
      <div className="grid gap-3 sm:grid-cols-3">
        {s.web && (
          <div className="rounded-xl border border-rule p-3">
            <p className="font-medium">BMC web console</p>
            <p className="mt-1 text-[12.5px] text-ink-3">{s.web.url ? <span className="font-mono">{s.web.url}</span> : 'No BMC address known'}</p>
            <p className="mt-1 text-[12.5px] text-ink-3">The BMC's own interface (iDRAC virtual console, virtual media). You sign in there.</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" disabled={!s.web.url} busy={web.isPending} onClick={() => web.mutate()}>
                Open in new tab
              </Button>
              {canSetup && (
                <Button size="sm" variant="ghost" onClick={() => setSetup('web')}>
                  Set address
                </Button>
              )}
            </div>
          </div>
        )}
        {(['vnc', 'sol'] as const).map((k) => (
          <div key={k} className="rounded-xl border border-rule p-3">
            <p className="font-medium">{CONSOLE_LABELS[k]}</p>
            <p className="mt-1 text-[12.5px] text-ink-3">{s[k].configured ? (staff ? `${s[k].host ?? 'management address'}:${s[k].port}${k === 'sol' && s[k].username ? ` as ${s[k].username}` : ''}` : 'Available') : 'Not set up'}</p>
            <p className="mt-1 text-[12.5px] text-ink-3">{k === 'vnc' ? 'Screen, keyboard and mouse here in NexoraDC.' : 'Text console (boot loader, kernel, login) here in NexoraDC.'}</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="primary" disabled={!s[k].configured || s.live.some((l) => l.kind === k)} onClick={() => setOpen(k)}>
                Open
              </Button>
              {canSetup && (
                <Button size="sm" variant="ghost" onClick={() => setSetup(k)}>
                  {s[k].configured ? 'Change' : 'Set up'}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
      {s.live.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          {s.live.map((l) => (
            <p key={l.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft px-3 py-1.5 text-[13px] text-warn">
              {CONSOLE_LABELS[l.kind]} in use by {l.user} since {relativeTime(l.since)}.
              {staff && (
                <Button size="sm" variant="ghost" busy={end.isPending} onClick={() => end.mutate(l.id)}>
                  End session
                </Button>
              )}
            </p>
          ))}
        </div>
      )}
      {s.recent.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[13px] text-ink-2">Session log ({s.recent.length})</summary>
          <Table label="Console sessions">
            <thead>
              <tr>
                <th>Started</th>
                <th>Console</th>
                <th>User</th>
                <th>Status</th>
                <th>Ended</th>
              </tr>
            </thead>
            <tbody>
              {s.recent.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap text-[12.5px]">{formatDateTime(r.createdAt)}</td>
                  <td className="text-[13px]">{r.kind.toUpperCase()}</td>
                  <td className="text-[13px]">{r.user}</td>
                  <td>
                    <Chip tone={STATUS_TONE[r.status]}>{r.status}</Chip>
                  </td>
                  <td className="text-[12.5px] text-ink-3">{[r.endedAt && formatDateTime(r.endedAt), r.endReason].filter(Boolean).join(' · ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </details>
      )}
      <Modal open={!!open} onOpenChange={(o) => !o && close()} title={open ? CONSOLE_LABELS[open] : ''} full>
        {open === 'vnc' && <VncViewer deviceId={deviceId} onClose={close} />}
        {open === 'sol' && <SolTerminal deviceId={deviceId} onClose={close} />}
      </Modal>
      <Modal open={!!setup} onOpenChange={(o) => !o && setSetup(null)} title={setup === 'web' ? 'BMC web address' : setup ? `Set up ${CONSOLE_LABELS[setup].toLowerCase()}` : ''}>
        {setup && <SetupForm deviceId={deviceId} kind={setup} onDone={() => setSetup(null)} />}
      </Modal>
    </Panel>
  );
}
