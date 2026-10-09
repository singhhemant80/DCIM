# Development and installation

## Requirements

- Node.js 22 LTS or newer, npm 10
- PostgreSQL 16 (TimescaleDB extension needed from Phase 4)
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
(cd apps/api && node dist/worker/main.js)   # discovery worker (needs Redis); without it runs stay "queued"
npm run dev:web                             # UI on http://localhost:5173 (proxies /api)
```

To try discovery without network gear, start the simulators used by the tests (a real SNMP agent on UDP 16161 and a RouterOS REST mock):

```bash
npx tsx apps/api/test/simulators/run.ts
```

Then add an SNMP v2c credential (host `127.0.0.1`, port `16161`, community `demo-public-ro`) to a router and run a discovery.

If `CDCIM_ADMIN_PASSWORD` is not set, `admin:create` generates a strong password and prints it once.

## Tests

```bash
npm test
```

API end-to-end tests need PostgreSQL and Redis (they wipe and recreate the `crapplet_dcim_test` database). Device adapters are exercised against simulators in `apps/api/test/simulators`: a real SNMP agent (net-snmp) on a random local UDP port and HTTP mocks of the RouterOS, FortiOS and NX-API endpoints.

- Unit tests need no services.
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
