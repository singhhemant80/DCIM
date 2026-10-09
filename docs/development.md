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
(cd apps/api && node dist/main.js)     # API on http://127.0.0.1:4000, docs at /api/docs
npm run dev:web                        # UI on http://localhost:5173 (proxies /api)
```

If `CDCIM_ADMIN_PASSWORD` is not set, `admin:create` generates a strong password and prints it once.

## Tests

```bash
npm test
```

- Unit tests need no services.
- API end-to-end tests boot the real application against PostgreSQL and Redis. They use `TEST_DATABASE_URL` (default `postgres://cdcim:cdcim_dev@127.0.0.1:5432/crapplet_dcim_test`) and **wipe that database** at the start of each file. The helper refuses to run unless the database name contains `test`.

## Production install on Ubuntu Server LTS (outline)

The full installer, upgrade and rollback scripts, and a tested procedure are Phase 9 deliverables. The files available now:

| File | Purpose |
|---|---|
| `deploy/env.example` | environment template for `/etc/crapplet-dcim/api.env` |
| `deploy/systemd/cdcim-api.service` | hardened systemd unit (runs as user `cdcim`, loopback only) |
| `deploy/nginx/crapplet-dcim.conf` | TLS, security headers and CSP, SPA serving, `/api` proxy with SSE support |
| `deploy/csp-hash.py` | recomputes the CSP hash for the inline theme script after a UI build |

Manual steps today: install `nodejs` 22, `postgresql-16`, `redis-server` and `nginx`; create the `cdcim` system user and database; copy a release to `/opt/crapplet-dcim/current`; run `npm ci --omit=dev` and the migrations; run `admin:create`; enable the unit and the nginx site; obtain a certificate with certbot.
