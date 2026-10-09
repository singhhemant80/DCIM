# Crapplet DCIM: architecture

Status: Phase 1 (Foundation) implemented. Later phases are designed here so the foundation does not need rework, but they are **not built yet**. See [feature-matrix.md](feature-matrix.md) for what works today.

## Goals that shape the design

1. **One source of truth** for physical, network, power and service inventory, with every change audited.
2. **Telemetry keeps flowing with nobody watching.** Polling runs in background workers, never in the browser or the API request path.
3. **Measured and estimated data are never confused.** Every bandwidth or power value carries its source, quality and sample time.
4. **Monitoring is separate from control.** Read-only collectors cannot change devices. Privileged operations (power, network configuration, provisioning) go through a separate, permissioned and audited path.
5. **Native Ubuntu deployment.** Every component runs under systemd on an Ubuntu LTS host. Docker is optional and used only for development services.

## Components

```mermaid
flowchart LR
  subgraph Browser
    SPA[React SPA<br/>Vite build]
  end
  subgraph Host["Ubuntu LTS host (systemd)"]
    NGINX[nginx<br/>TLS, static SPA, /api proxy]
    API[cdcim-api<br/>NestJS REST + SSE]
    WRK[cdcim-worker<br/>BullMQ consumers: discovery (3), polling (4+)]
    SCH[cdcim-scheduler<br/>repeatable jobs, Phase 4+]
  end
  PG[(PostgreSQL 16<br/>+ TimescaleDB, Phase 4+)]
  RD[(Redis 7<br/>queues, locks, pub/sub)]
  S3[(S3-compatible storage<br/>attachments, reports, backups)]
  DEV[[Network devices, BMCs,<br/>Proxmox, Virtualizor, WHMCS]]

  SPA -- HTTPS same origin --> NGINX --> API
  API --> PG
  API --> RD
  WRK --> PG
  WRK --> RD
  SCH --> RD
  WRK -- SNMP / Redfish / APIs<br/>management network only --> DEV
  API -. webhooks in .-> DEV
  API --> S3
```

| Process | Responsibility | Phase |
|---|---|---|
| `cdcim-api` | REST API (`/api/v1`), auth, RBAC, validation, OpenAPI, SSE fan-out of live updates | 1 |
| `cdcim-worker` | Executes queued jobs. Phase 3: read-only discovery runs (the only process that decrypts device credentials). Later: SNMP/API polling, power collection, provisioning steps, webhook delivery, notifications | 3 |
| `cdcim-scheduler` | Single leader (Redis lock) that enqueues repeatable jobs at configured intervals | 4 |
| nginx | TLS termination, serves the built SPA, proxies `/api` to the API on 127.0.0.1 | 1 (config), 9 (validated) |

The API and the SPA share one origin, so session cookies stay first-party and CORS is not needed in production.

## Repository layout

```
crapplet-dcim/
├── apps/
│   ├── api/                 NestJS API
│   │   ├── src/
│   │   │   ├── auth/        sessions, passwords, MFA, guards, decorators
│   │   │   ├── audit/       hash-chained audit log
│   │   │   ├── tenancy/     tenant row filters
│   │   │   ├── customers/ users/ roles/ settings/ overview/ health/
│   │   │   ├── common/      logging, errors, validation, SecretBox encryption
│   │   │   ├── db/          Drizzle schema + pool
│   │   │   └── cli/         migrate, create-admin, seed
│   │   ├── drizzle/         SQL migrations (checked in, applied in order)
│   │   └── test/            end-to-end tests against real Postgres + Redis
│   └── web/                 React + Vite + Tailwind SPA
├── packages/
│   └── shared/              permission catalog, roles, navigation, Zod schemas, unit formatting
├── deploy/                  env example, systemd units, nginx, docker-compose (dev only)
└── docs/                    this documentation
```

`@crapplet/shared` is imported by both the API and the SPA, so validation rules, permission names and the list of navigation sections cannot drift apart.

## Request path

1. nginx terminates TLS and forwards `/api/*` to `127.0.0.1:4000`.
2. Helmet sets security headers; `pino-http` assigns or accepts an `X-Request-Id`.
3. Global guards run in order: **rate limit → authenticate (session + CSRF + MFA gate) → authorize (permissions, staff-only)**.
4. Controllers validate input with the shared Zod schemas (`ZodPipe`) and call services.
5. Services add a **tenant filter** to every query and write the change and its audit record **in the same transaction**.
6. `AllExceptionsFilter` returns `{ error, message, requestId, issues? }` and never leaks stack traces or SQL.

## Real-time design (Phase 4)

- Workers write samples to TimescaleDB hypertables and publish a compact update on a Redis channel per device.
- The API exposes `GET /api/v1/stream` (Server-Sent Events). Each connection subscribes only to the channels its principal is permitted to see, so the tenant filter applies to the stream too.
- Every pushed value carries `sampledAt`. The UI marks values **stale** when `now - sampledAt` exceeds the configured stale threshold, and never presents a cached value as live.

SSE was chosen over WebSockets because updates only flow server to client, it works through nginx with no upgrade handling, and it reconnects automatically.

## Polling design (Phase 4)

```mermaid
sequenceDiagram
  participant S as scheduler (leader)
  participant Q as Redis / BullMQ
  participant W as worker pool
  participant D as device (SNMP)
  participant DB as TimescaleDB
  S->>Q: enqueue poll(device, interval) every N s (jobId = device+slot, so no duplicates)
  Q->>W: deliver (bounded concurrency per worker and per device)
  W->>D: GETBULK IF-MIB / ifXTable (HC counters), timeout + retries
  D-->>W: counters + sysUpTime
  W->>W: delta vs previous counters: wrap, reset (sysUpTime drop), speed change, gap checks
  W->>DB: insert raw counters + derived rates (with quality flags)
  W->>Q: publish live update; evaluate alert rules
```

Key rules, implemented as pure functions with unit tests in Phase 4:

- `rate = Δoctets × 8 / Δt`, using 64-bit HC counters when available. A negative delta with a `sysUpTime` decrease is a **reset** (sample discarded, not a spike). A negative delta on a 32-bit counter without a reset is a **wrap** (add 2³²).
- Utilization is computed only when link speed is known and consistent between the two samples. Otherwise it is `null` and flagged `speed_unknown`.
- A gap longer than 3× the interval produces **no rate** for that span. Missing data is stored as missing, never as zero.
- Aggregates skip LAG member ports when the LAG interface itself is included, and only interfaces flagged `countInTotals` contribute to device and site totals.

## Power design (Phase 5)

Each device has at most one **effective power source** per reading window, chosen by priority: measured telemetry (Redfish/iDRAC/SNMP/PDU outlet) → vendor-reported → admin estimate → spec-based estimate → unknown. Totals report measured and estimated subtotals separately and list unknown devices. Energy from measured data is a time-weighted trapezoidal integration over timestamped readings that does not bridge gaps. Estimated energy is `W × hours / 1000`, with its assumptions shown.

## Configuration

All configuration comes from environment variables, validated at startup ([`config.ts`](../apps/api/src/config/config.ts)). The process refuses to start when a value is missing or insecure, for example `COOKIE_SECURE=false` in production. See [`deploy/env.example`](../deploy/env.example).
