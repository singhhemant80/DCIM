# Crapplet DCIM

Datacenter infrastructure management for Crapplet Infotech Private Limited: physical inventory, racks, network and IPAM, real-time port bandwidth, equipment power (no physical meters needed), server provisioning, colocation, a customer portal and WHMCS billing integration.

**Current state: Phases 1–4 complete.** Sign-in with two-step verification, roles and permissions, customer tenants, a tamper-evident audit log and system settings; physical DCIM (datacenters, rooms, floor plans, racks with database-enforced placement, hardware inventory with lifecycle, CSV, QR labels, spare parts); and network infrastructure and IPAM: ports and logical interfaces, cabling, VLANs, VRFs, circuits, a topology drawn only from verified sources, IPv4/IPv6 prefixes with concurrency-safe allocation, read-only discovery over SNMP, RouterOS REST and API, FortiOS REST and NX-API through a separate worker process (on demand or on a schedule), recording discovered addresses in IPAM, and publishing IPAM names to PowerDNS or Cloudflare; and real-time network monitoring: per-port traffic polled from the same read-only access methods, live updates, history with 95th percentile, totals, alert rules with maintenance windows and email/webhook/Slack/Telegram notifications. Device adapters are tested against simulators, not yet on real hardware. Sections not built yet are marked as planned in the UI. See the [feature matrix](docs/feature-matrix.md).

## Install

**Ubuntu 22.04/24.04 or Debian 12 server** (one command, run again to upgrade):

```bash
curl -fsSL https://raw.githubusercontent.com/singhhemant80/DCIM/main/scripts/install.sh | sudo bash
```

**Windows 10/11** (Administrator PowerShell, uses WSL2 Ubuntu):

```powershell
irm https://raw.githubusercontent.com/singhhemant80/DCIM/main/scripts/install-windows.ps1 | iex
```

While the repository is private, see [docs/development.md](docs/development.md#one-command-install-ubuntu-debian-wsl) for the token variant.

Then open http://localhost:8080 and sign in with the administrator email and the password the installer prints. Options (port, LAN access, branch) are listed at the top of [`scripts/install.sh`](scripts/install.sh).

## Documentation

| | |
|---|---|
| Stack | React 19, Vite, Tailwind 4, NestJS 11, PostgreSQL 16, Redis 7, TypeScript throughout |
| Run it | [docs/development.md](docs/development.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) |
| Database | [docs/database.md](docs/database.md) |
| API | [docs/api.md](docs/api.md) (OpenAPI at `/api/docs`) |
| Security | [docs/security.md](docs/security.md) |
| Integrations | [docs/integrations.md](docs/integrations.md) |
| Roadmap | [docs/roadmap.md](docs/roadmap.md) |
