# Operations guide

How to install, check, back up, restore, upgrade and roll back a NexoraDC
server, and what to do when something is wrong. Everything here was run on a
clean Ubuntu 24.04 system during Phase 9; the results are in the
[acceptance report](acceptance-report.md).

## Requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Ubuntu 22.04 or 24.04 LTS, Debian 12 (x86_64 or arm64) | Ubuntu 24.04 LTS |
| CPU / memory | 2 cores / 2 GB | 4 cores / 8 GB for 5,000+ monitored ports |
| Disk | 3 GB free under `/opt`, `/var/lib` and `/var/backups` | 40 GB+ (monitoring data, backups) |
| Network out | GitHub, `registry.npmjs.org`, `deb.nodesource.com`, the Ubuntu mirrors (installs and upgrades only) | |
| Network in | the web port (8080 by default, or 80/443 with a domain) | |
| Management network | the server must reach BMCs (443, 623/udp, 5900), switches and routers (SNMP 161/udp, vendor APIs) | |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/singhhemant80/DCIM/main/scripts/install.sh | sudo bash
```

The installer checks the system first (OS release, architecture, memory, free
disk, a free port) and stops with an explanation if something is missing.
On minimal Ubuntu images it enables the `universe` component, which holds
`redis-server` and `ipmitool`. It then:

1. installs PostgreSQL, Redis, Git, ipmitool, Node.js 22 and unattended security upgrades;
2. creates the `cdcim` service account, the database and `/etc/crapplet-dcim/api.env` (random database password and encryption key);
3. builds the release in `/opt/crapplet-dcim/releases/<date>-<commit>` and points `/opt/crapplet-dcim/app` at it. Releases belong to root, so the service account can run the code but cannot change it;
4. applies database migrations and creates the first administrator (the password is shown once);
5. installs the systemd services `crapplet-dcim` (API and web) and `crapplet-dcim-worker` (polling, alerts, power, BMC reads, provisioning, consoles), plus two daily timers: `crapplet-dcim-backup` and `crapplet-dcim-anchor`;
6. creates the backup key `/etc/crapplet-dcim/backup.key`, takes the first backup, and runs the install check.

**Copy the backup key off the server straight away** (`sudo cat /etc/crapplet-dcim/backup.key`).
Backups cannot be read without it.

### Options

| Variable | Default | Meaning |
|---|---|---|
| `CDCIM_DOMAIN` | | Serve `https://DOMAIN` through nginx. The API then listens on loopback only |
| `CDCIM_TLS` | `letsencrypt` | With a domain: `letsencrypt` (public DNS and port 80 needed) or `selfsigned` |
| `CDCIM_TLS_EMAIL` | | Contact address for Let's Encrypt |
| `CDCIM_PORT` | `8080` | Port of the web UI and API |
| `CDCIM_BIND` | `127.0.0.1` | Listen address; `0.0.0.0` for access by IP |
| `CDCIM_INSECURE_HTTP` | | `1` allows sign-in over plain `http://` by IP. Lab use only |
| `CDCIM_ADMIN_EMAIL`, `CDCIM_ADMIN_NAME` | asked | First administrator |
| `CDCIM_GITHUB_TOKEN` | | Read-only token for a private repository; used in memory only |
| `CDCIM_BRANCH` | `main` | Branch or tag to install |

Recommended production install:

```bash
curl -fsSL https://raw.githubusercontent.com/singhhemant80/DCIM/main/scripts/install.sh \
  | sudo CDCIM_DOMAIN=dcim.example.com CDCIM_TLS_EMAIL=noc@example.com bash
```

Existing installs that use plain HTTP by IP (`CDCIM_BIND=0.0.0.0 CDCIM_INSECURE_HTTP=1`)
keep working. The install check reports them as warnings until TLS is in front.

## Daily commands

| Command | What it does |
|---|---|
| `sudo crapplet-dcim status` · `logs` · `restart` | Service status, live logs, restart (API and worker) |
| `sudo crapplet-dcim doctor` | Install check: configuration, database and migrations, Redis, worker heartbeat, stored secrets, audit log and anchors, MFA of staff accounts, services and timers, file permissions, backups, disk, listening addresses, firewall, TLS certificate. Exit code 1 if anything failed |
| `sudo crapplet-dcim backup` · `backups` | Take an encrypted backup now; list backups |
| `sudo crapplet-dcim restore FILE` | Restore a backup (asks you to type RESTORE) |
| `sudo crapplet-dcim releases` · `rollback` | List installed releases; go back to the previous one |
| `sudo crapplet-dcim secrets check` · `rotate` | Stored credentials versus encryption keys; re-encrypt with the newest key |
| `sudo crapplet-dcim anchor` | Record the audit log heads outside the database (runs daily) |
| `sudo crapplet-dcim version` | The running release |

Each line of `doctor` output is `PASS`, `WARN` or `FAIL`, and anything that is
not `PASS` comes with a `fix:` line. Run it after every change to the server.

## Backups

* **What:** the database (`pg_dump` custom format), `/etc/crapplet-dcim/api.env`
  (database password and the encryption keys that protect stored credentials),
  and the audit anchors, with a manifest of SHA-256 checksums.
* **Encryption:** AES-256-CTR with a key derived (PBKDF2) from `/etc/crapplet-dcim/backup.key`,
  then HMAC-SHA256 over the result (encrypt-then-MAC). A changed, truncated or
  wrong-key backup is refused before anything is decrypted or touched.
* **When:** daily at 02:15 (randomised by up to 30 minutes), before every upgrade,
  and before every restore. The newest 14 daily/manual backups and the last 3
  pre-upgrade backups are kept in `/var/backups/crapplet-dcim` (root only).
* **Off-site:** copy `/var/backups/crapplet-dcim/*.cdcim-backup` to another system
  (rsync, object storage). They are safe to store anywhere because they are
  encrypted, but keep the backup key separate from them.

### Restore

```bash
sudo crapplet-dcim backups
sudo crapplet-dcim restore /var/backups/crapplet-dcim/nexoradc-20261014-021501-manual.cdcim-backup
```

The restore verifies and decrypts the file, shows when and where it was made,
asks for confirmation, saves the current state as a `pre-restore` backup,
stops the services, re-creates the database, restores the configuration
(`--keep-config` keeps the current one), applies any newer migrations, starts
the services and runs the install check. Audit anchors recorded after the
backup are moved aside to `anchors-before-restore-*.jsonl`, because the
restored log ends at the backup.

**On a new server:** run the installer, put the original backup key in
`/etc/crapplet-dcim/backup.key` (mode 0600), copy the backup file over, and run
`restore`. The configuration in the backup brings the old encryption keys, so
stored device and BMC credentials keep working.

## Upgrades and rollback

Re-run the install command. The new release is built next to the running one
(nothing changes if the build fails), a `pre-upgrade` backup is taken,
migrations are applied, and the service switches to the new release. If the
new release is not healthy within 60 seconds, the installer switches back
automatically and, if migrations ran, restores the pre-upgrade backup.

To go back later: `sudo crapplet-dcim rollback`. If the upgrade changed the
database schema, the rollback restores the pre-upgrade backup, so changes made
since the upgrade are lost (they are kept in a `pre-restore` backup). The
current release and two before it are kept.

## Security tasks

* **MFA:** every staff account should enable two-factor sign-in (Account page). `doctor` lists how many have not.
* **TLS:** use `CDCIM_DOMAIN`. Plain HTTP exposes session cookies on the network.
* **Encryption key rotation** (yearly, or when someone with access to `api.env` leaves):
  1. add a new key first in `CDCIM_ENCRYPTION_KEYS` in `/etc/crapplet-dcim/api.env` (`k$(date +%Y%m):$(openssl rand -base64 32)`), keeping the old key after it;
  2. `sudo crapplet-dcim restart`;
  3. `sudo crapplet-dcim secrets rotate`, then `secrets check`, which should report `Secrets on older keys: 0`;
  4. remove the old key, restart, and take a backup.
* **Audit anchors:** `crapplet-dcim anchor` records the newest audit event and its hash for each organization in `/var/lib/crapplet-dcim-anchors/anchors.jsonl`. The service account cannot change that file, so if somebody with database access deletes or rewrites recent audit events, `doctor` reports it. Copy `anchors.jsonl` off the server as well; it is small.
* **Management network:** the worker reaches BMCs, switches and hypervisors. Give the server access to the management network only, and only to the ports listed above.
* **Firewall:** allow only the web port (or 80/443). PostgreSQL and Redis listen on loopback, and `doctor` warns if they do not.

## Monitoring the server itself

* `GET /api/v1/health/ready` returns 200 when the database and Redis answer, with `worker: running | not_seen`. Point an external monitor at it.
* `doctor` exits non-zero on a failure, so it can run from cron and mail its output.
* Logs: `journalctl -u crapplet-dcim -u crapplet-dcim-worker`. Secrets are never logged.

## Troubleshooting

Problems seen on real installs:

| Symptom | Cause | Fix |
|---|---|---|
| Browser: "site can't be reached"; `curl` to the IP works on the server itself | firewalld (or ufw) blocks the port | `firewall-cmd --permanent --add-port=8080/tcp && firewall-cmd --reload`. `doctor` checks this |
| Sign-in does nothing over `http://IP:8080` | Secure cookies need HTTPS | Use `CDCIM_DOMAIN`, or (lab only) `CDCIM_INSECURE_HTTP=1` |
| Redfish credential test: "Redfish attribute is disabled" | Redfish is off on the iDRAC | iDRAC → Settings → Services → Redfish → Enabled |
| BMC memory list empty, "no Memory collection" | Older iDRAC firmware has no Redfish memory list | Memory is read over WS-Man instead (automatic). Updating the iDRAC firmware adds the Redfish list |
| Virtualizor: credentials rejected (HTTP 302) | Admin API key or pass wrong, or this server's IP not in the API allow-list | Create an API key in Virtualizor → Configuration → API credentials and add the DCIM server's IP |
| Worker `not_seen` in readiness, polling stopped | Worker stopped or crashed | `systemctl status crapplet-dcim-worker`, `journalctl -u crapplet-dcim-worker -n 100` |
| Ping checks fail to a server on the same LAN segment as a router that sends ICMP redirects | Cached redirect route | `ip route flush cache`; disable `accept_redirects` on the DCIM server |
| `doctor`: secrets cannot be decrypted | A key was removed from `CDCIM_ENCRYPTION_KEYS`, or a credential row was edited outside the app | Put the old key back (after the active one), or enter those credentials again |

## Files

| Path | Contents | Owner, mode |
|---|---|---|
| `/opt/crapplet-dcim/releases/*` | Built releases (current and two previous) | root, read-only to others |
| `/opt/crapplet-dcim/app` | Symlink to the current release | root |
| `/etc/crapplet-dcim/api.env` | Configuration and secrets | root:cdcim 0640 |
| `/etc/crapplet-dcim/backup.key` | Backup key | root 0600 |
| `/etc/crapplet-dcim/install.conf` | Paths used by `crapplet-dcim` | root 0644 |
| `/var/backups/crapplet-dcim` | Encrypted backups | root 0700 |
| `/var/lib/crapplet-dcim-anchors` | Audit anchors | root 0700 |
| `/var/lib/crapplet-dcim` | Deploy, rollback and restore logs | cdcim 0750 |
| `/var/log/crapplet-dcim` | Installer and build logs, `doctor.log` | cdcim 0750 |
