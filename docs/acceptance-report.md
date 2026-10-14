# Acceptance report: Phase 9 (production readiness)

Date: 14 October 2026. Code: commit after `e248fa2` (Phase 9).
Raw outputs: [`docs/acceptance/2026-10-14/`](acceptance/2026-10-14/).

## What was tested, and on what

| | |
|---|---|
| Clean system | Ubuntu 24.04 LTS built with `debootstrap --variant=minbase` (only the `main` component, like a minimal cloud image), booted with **systemd as PID 1** in a privileged container on the build machine |
| Build machine | 2 vCPU, 8 GB RAM, Linux 6.18 |
| Installer source | This repository's working tree (`CDCIM_SOURCE_DIR`), and commit `e248fa2` for the "previous installer" |
| Packages | Installed by the installer from the Ubuntu archive: PostgreSQL 16.2, Redis 7.0, nginx 1.24, ipmitool |
| Node.js 22 | **Pre-copied** into the system because the build machine's proxy does not allow `deb.nodesource.com`. Everything else (apt, GitHub, npm registry) was fetched over the network as on a real server |
| Harness | [`scripts/test-install-container.sh`](../scripts/test-install-container.sh), reproducible on any Linux host with docker and debootstrap |

**Not tested:** a hardware VM or bare-metal server, Ubuntu 22.04, Debian 12,
WSL, Let's Encrypt issuance (it needs public DNS; the self-signed TLS path was
tested), real BMCs and switches (the acceptance run sends nothing to devices).

## Results

The final run had 38 automated checks and 5 checks run by hand. All passed. Full log: [install-validation.txt](acceptance/2026-10-14/install-validation.txt).

| # | Scenario | Result |
|---|---|---|
| 1 | Fresh install (164 s) | ✅ Installer enabled `universe` on the minimal image; API, worker, PostgreSQL and Redis active under systemd; backup and anchor timers enabled; installed code owned by root, and the service account cannot write it |
| 2 | Install check and acceptance | ✅ `doctor`: 32 pass, 3 warnings, 0 failures. The warnings were expected: no device allow-list, admin without MFA, container clock not NTP-synced. Acceptance read+write: **48/48** |
| 3 | Backup and restore drill | ✅ Encrypted backup of 737 KB, unreadable without the key. A damaged copy was refused before anything changed. Restore took 9 s. A row added after the backup was gone after the restore; the audit chain and anchors verified; acceptance 43/43 afterwards |
| 4 | Upgrade (111 s) | ✅ Pre-upgrade backup taken; new release switched in (the upgrade also added a database migration); acceptance passed |
| 5 | Upgrade whose release cannot start | ✅ Detected within 60 s and rolled back automatically; the previous release stayed healthy |
| 6 | Manual `crapplet-dcim rollback` | ✅ Back on the previous release. Because the upgrade had changed the schema (20 → 21 migrations), the database was restored from the pre-upgrade backup and the upgrade's table was gone; acceptance passed |
| 7 | Restart (reboot) | ✅ Services came back by themselves; `doctor` showed no failures |
| 8 | Upgrade of an install made by the previous installer (plain HTTP by IP, single checkout) | ✅ Converted to the release layout, data kept, `doctor` showed no failures, acceptance 48/48 |
| 9 | Moving that install to HTTPS (`CDCIM_DOMAIN`, self-signed) | ✅ Service moved to loopback with secure cookies; `http://` returns 301 to `https://`; HSTS, CSP and nosniff present on the app page; acceptance over HTTPS 48/48; app loaded in Chromium without CSP errors; `doctor` showed no failures |

In step 9 the harness stopped after the redirect check: its `curl` went through
the build machine's proxy. The remaining step 9 checks were run by hand
against the same container, and the harness was then fixed.

### Acceptance run contents

[`scripts/acceptance.mjs`](../scripts/acceptance.mjs) covers:

* **Platform:** liveness; readiness (database, Redis, worker heartbeat); the app page and its security headers.
* **Security behaviour:** anonymous requests refused; wrong password refused; changes without a CSRF token refused; session invalid after sign-out.
* **Every section:** the main view of each, 32 endpoints in all.
* **Reports and audit:** a CSV report; the audit chain verified.
* **Writes (with `--write`):**
  * build datacenter → building → room → rack;
  * create a model and a server, place it in the rack, and check that placement above the rack top is refused;
  * create an IP prefix and allocate two addresses atomically;
  * create a customer and a half-rack allocation;
  * check that these changes are in the audit log and the chain still verifies.

## Poller load test

[`apps/api/test/load/poller.load.ts`](../apps/api/test/load/poller.load.ts) runs the worker's real poll loop:

* claiming due devices with SKIP LOCKED;
* SNMP v2c GETBULK against simulated agents;
* the rate engine, raw storage and alert evaluation;
* the API answering the busiest-ports list at the same time.

Everything ran on one 2-vCPU machine: PostgreSQL, the poller with the API, and the SNMP simulator (in its own process).

| Scenario | Polls done / due | Poll time p50 / p95 | Schedule lag (max) | API port list p95 | CPU: poller+API / simulator | Rate rows | Rollup |
|---|---|---|---|---|---|---|---|
| **4,800 ports** (100 devices × 48) every 60 s, 5 min | 498 / 500 (99.6%) | 316 / 659 ms | 1.9 s | 64 ms | 14% of a core / — | 19,104 | 398 ms |
| 14,400 ports (300 × 48) every 30 s, 3 min, 32 at a time | 1,212 / 1,800 (67%) | 2.5 / 2.9 s | 23 s | 241 ms | 47% / 54% | 43,776 | 809 ms |
| 14,400 ports every 10 s, 2 min | 604 / 3,600 (17%) | 1.5 / 2.0 s | 56 s | 155 ms | 31% / — (simulator saturated) | 0 | — |

What this shows:

* A typical datacenter (thousands of ports, 60-second polling) is handled with a large margin. No poll failed and the schedule lag stayed under 2 seconds.
* On this 2-vCPU machine the ceiling is about **6–7 device polls per second (≈320 port samples/s)**, with PostgreSQL, the simulator and the poller sharing the CPUs. That is roughly 14,400 ports every 45 seconds or 4,800 ports every 15 seconds.
* Past the ceiling the poller degrades the way it was designed to: devices are polled late rather than in parallel pile-ups. Over a long gap, rates are not computed rather than averaged into misleading values (0 rate rows at 10 s).
* The API stays responsive under load.
* For more ports, add CPU first. Raising `POLL_CONCURRENCY` above 16 did not help here because the CPU was the limit.

## Defects found by this validation and fixed

1. **Minimal Ubuntu install failed:** `redis-server` and `ipmitool` are in `universe`, which minimal images leave out. The installer now enables it.
2. **`crapplet-dcim backup` reported failure after writing the backup** (pruning with `pipefail` and no older files).
3. **Restore could leave the server without a database.** PostgreSQL could not read the root-only decrypted dump, after the database had already been dropped. The restore now streams the dump, loads it into a separate database, and switches only after the load succeeds.
4. **nginx template:**
   * `http2 on` is not supported by nginx 1.24 (Ubuntu 24.04), so nginx refused the config;
   * `add_header` inside the locations silently dropped **all security headers** (CSP, HSTS, nosniff) from the app page;
   * the CSP blocked the app's embedded fonts;
   * `listen [::]` fails on hosts without IPv6.
5. **Moving an existing install to HTTPS** switched the service to loopback before nginx was known to work, which could lock users out. nginx and TLS are now set up and tested first.
6. **Release permissions** depended on the source directory's permissions (one copy made the release unreadable by the service).
7. **Worker heartbeat:** its first write ran before Redis had connected.

## Security review (self-review)

Phase 9 code was reviewed by its author, not independently. The findings were fixed:

* backups and anchors originally ran application code as root;
* the backup MAC key was visible in the process list;
* items 3–5 above.

Remaining limits are listed in [security.md](security.md#phase-9-production-hardening). An independent review is recommended before production use.

## Automated tests

* **API:** 476 tests. In the full run, 475 passed and 1 failed: the known timing-sensitive test in `monitoring.e2e` (rates from the SNMP agent), which passes when run alone (43/43).
* **New in Phase 9:** 11 tests in `production.e2e`:
  * rate limits shared through Redis, with the in-memory fallback;
  * key rotation, coverage of every encrypted column, and tampered rows;
  * the device allow-list across all adapters;
  * doctor checks;
  * readiness with the worker heartbeat;
  * audit anchors detecting removed or rewritten events.
* **Shared and web:** 21 and 10 tests, all passed.

## How to repeat

```bash
sudo scripts/test-install-container.sh --legacy-ref <previous-commit> /tmp/install-run
CDCIM_ACCEPT_EMAIL=… CDCIM_ACCEPT_PASSWORD=… node scripts/acceptance.mjs --url https://dcim.example.com
cd apps/api && LOAD_DEVICES=100 LOAD_PORTS=48 LOAD_INTERVAL=60 LOAD_DURATION=300 npx vitest run -c vitest.load.config.ts
```
