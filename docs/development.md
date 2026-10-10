# Development and installation

## Requirements

- Node.js 22 LTS or newer, npm 10
- PostgreSQL 14 or newer (16 recommended); no extensions beyond the built-in ones
- Redis 7

## Run locally

```bash
# 1. Services: either native packages or the dev compose file
docker compose -f deploy/docker-compose.dev.yml up -d
#    (native: create role cdcim, databases crapplet_dcim and crapplet_dcim_test owned by it)

# 2. Dependencies
npm ci

# 3. API configuration
cat > apps/api/.env <<ENV
NODE_ENV=development
DATABASE_URL=postgres://cdcim:cdcim_dev@127.0.0.1:5432/crapplet_dcim
REDIS_URL=redis://127.0.0.1:6379
CDCIM_ENCRYPTION_KEYS=k1:$(openssl rand -base64 32)
ENV

# 4. Build, migrate, create the first administrator, optional sample data
npm run build
set -a; . apps/api/.env; set +a
npm run db:migrate
CDCIM_ADMIN_PASSWORD='choose-a-long-passphrase' npm run admin:create -- --email you@crapplet.in --name "Your Name"
npm run db:seed          # dev only: 2 sample customers, a NOC user and a customer admin

# 5. Start
(cd apps/api && node dist/main.js)          # API on http://127.0.0.1:4000, docs at /api/docs
(cd apps/api && node dist/worker/main.js)   # worker: discovery, DNS, polling, rollups, alerts, notifications
npm run dev:web                             # UI on http://localhost:5173 (proxies /api)
```

To try discovery without network gear, start the simulators used by the tests (a real SNMP agent on UDP 16161 and a RouterOS REST mock):

```bash
npx tsx apps/api/test/simulators/run.ts
```

Then add an SNMP v2c credential (host `127.0.0.1`, port `16161`, community `demo-public-ro`) to a router and run a discovery. The SNMP simulator's counters advance every 5 s with invented traffic, so you can also enable polling for that router (Monitoring & Alerts → Polling) and watch Network Monitoring. That traffic is simulated.

The simulators also start a Redfish BMC (`http://127.0.0.1:18080`, `root` / `demo-bmc-pass`, scheme HTTP) and an APC metered PDU (SNMP v2c on UDP 16162, community `demo-pdu-ro`) whose figures wander, for trying Power Consumption. Their power figures are invented. IPMI needs `ipmitool` on the worker host (`IPMITOOL_PATH` overrides its location).

For Phase 6 the simulators add a Redfish BMC that changes power, boot override and virtual media (`http://127.0.0.1:18081`, `dcim-ctl` / `demo-ctl-pass`) and plays the installer for MAC `52:54:00:de:00:01` (it fetches its config from `DCIM_URL`, default `http://127.0.0.1:4000`, and reports done), an image mirror on `http://127.0.0.1:18090` (SHA-256 values printed at start), a Proxmox VE API on `http://127.0.0.1:18006` (read token `dcim@pve!read` / `demo-pve-read`, action token `dcim@pve!ops` / `demo-pve-ops`) and a Virtualizor API on `http://127.0.0.1:14085` (`DEMOKEY-VZ-2026` / `demo-vz-pass`). To use them locally start the API and worker with `CDCIM_PUBLIC_URL=http://127.0.0.1:4000`, `CDCIM_BOOT_ALLOW=127.0.0.0/8` and `CDCIM_IMAGE_ALLOW_LOCAL=true`. Everything they report is simulated.

Worker settings: `POLL_CONCURRENCY` (devices polled at once, default 16), `DISCOVERY_CONCURRENCY` (default 4), `PROVISIONING_CONCURRENCY` (jobs run at once, default 4), `CDCIM_NOTIFY_ALLOW_PRIVATE=true` to allow webhook/SMTP destinations on private or local addresses, `CDCIM_IMAGE_ALLOW_LOCAL=true` to allow image URLs on loopback/link-local addresses.

Provisioning settings (API and worker): `CDCIM_PUBLIC_URL` (scheme and host the installing servers use to reach DCIM, e.g. `http://10.0.0.5:8080`; required for PXE and templates) and `CDCIM_BOOT_ALLOW` (CIDR list allowed to use `/api/v1/boot/*`, default the private ranges).

If `CDCIM_ADMIN_PASSWORD` is not set, `admin:create` generates a strong password and prints it once.

## Tests

```bash
npm test
```

API end-to-end tests need PostgreSQL and Redis (they wipe and recreate the `crapplet_dcim_test` database). Device adapters are exercised against simulators in `apps/api/test/simulators`: a real SNMP agent (net-snmp) on a random local UDP port and HTTP mocks of the RouterOS, FortiOS and NX-API endpoints.

- Unit tests need no services.
- The WHMCS module's offline checks: `php integrations/whmcs/tests/client_test.php` (PHP 8.1+ with curl).
- API end-to-end tests boot the real application against PostgreSQL and Redis. They use `TEST_DATABASE_URL` (default `postgres://cdcim:cdcim_dev@127.0.0.1:5432/crapplet_dcim_test`) and **wipe that database** at the start of each file. The helper refuses to run unless the database name contains `test`.

## One-command install (Ubuntu, Debian, WSL)

`scripts/install.sh` installs Node.js 22, PostgreSQL and Redis, creates a `cdcim` system user and database with random secrets (`/etc/crapplet-dcim/api.env`), builds the app, applies migrations, creates the first administrator (password printed once) and starts the service on port 8080, where one process serves both the UI and the API. Re-running it upgrades in place.

```bash
curl -fsSL https://raw.githubusercontent.com/singhhemant80/DCIM/main/scripts/install.sh | sudo bash
```

| Variable | Default | Purpose |
|---|---|---|
| `CDCIM_REPO` | `https://github.com/singhhemant80/DCIM.git` | Git URL to install from |
| `CDCIM_GITHUB_TOKEN` | none | Read-only token, needed only while the repository is private |
| `CDCIM_BRANCH` | `main` | Branch or tag |
| `CDCIM_ADMIN_EMAIL`, `CDCIM_ADMIN_NAME` | prompted | First administrator |
| `CDCIM_PORT` | `8080` | Port for UI and API |
| `CDCIM_BIND` | `127.0.0.1` | `0.0.0.0` to listen on the LAN |
| `CDCIM_INSECURE_HTTP` | `0` | `1` allows sign-in over plain `http://` by IP (lab only; use HTTPS for real use) |

Service control: `sudo crapplet-dcim {start|stop|restart|status|logs}` (uses systemd when available, otherwise a built-in process manager, as on WSL without systemd).

Verified so far: fresh install, re-run upgrade (data, secrets and admin kept), and the `curl | bash` form, on Ubuntu 24.04 without systemd. Sign-in on the installed instance was tested in a real browser. The systemd branch and `scripts/install-windows.ps1` have been reviewed but not yet run on a systemd host or on Windows.

**Private repository:** create a fine-grained token with *Contents: Read-only* on this repository, then:

```bash
export GH_TOKEN=github_pat_xxx
curl -fsSL -H "Authorization: token $GH_TOKEN" https://raw.githubusercontent.com/singhhemant80/DCIM/main/scripts/install.sh | sudo CDCIM_GITHUB_TOKEN=$GH_TOKEN bash
```

The token is used in memory for that run only and is not written to the server.

## Production install on Ubuntu Server LTS (manual outline)

The full installer, upgrade and rollback scripts, and a tested procedure are Phase 9 deliverables. The files available now:

| File | Purpose |
|---|---|
| `deploy/env.example` | environment template for `/etc/crapplet-dcim/api.env` |
| `deploy/systemd/cdcim-api.service` | hardened systemd unit (runs as user `cdcim`, loopback only) |
| `deploy/nginx/crapplet-dcim.conf` | TLS, security headers and CSP, SPA serving, `/api` proxy with SSE support |
| `deploy/csp-hash.py` | recomputes the CSP hash for the inline theme script after a UI build |

Manual steps today: install `nodejs` 22, `postgresql-16`, `redis-server` and `nginx`; create the `cdcim` system user and database; copy a release to `/opt/crapplet-dcim/current`; run `npm ci --omit=dev` and the migrations; run `admin:create`; enable the unit and the nginx site; obtain a certificate with certbot.
