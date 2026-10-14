#!/usr/bin/env bash
# Install validation on a clean Ubuntu 24.04 system, booted with systemd in a
# container. Exercises the real installer and the operations it sets up:
#
#   1. fresh install (from this checkout) on a minimal Ubuntu with only the "main" component
#   2. install check (doctor) and the acceptance run (read and write)
#   3. backup → change data → restore → the change is gone, audit chain intact
#   4. upgrade (pre-upgrade backup, new release, switch)
#   5. upgrade whose release cannot start → automatic rollback
#   6. manual rollback to the previous release
#   7. container restart (reboot): services and timers come back
#   8. the upgrade path from an install made by the previous installer (--legacy)
#
# Usage (as root, with docker and debootstrap):
#   scripts/test-install-container.sh [--keep] [--legacy-ref GITREF] OUTDIR
# Environment:
#   CDCIM_TEST_HOST_NETWORK=1   use the host network (needed behind an HTTP proxy that listens on
#                               127.0.0.1; ports 5432, 6379 and 8080 on the host must then be free)
#   CDCIM_TEST_CA=/path/ca.crt  extra CA certificate for a TLS-intercepting proxy
#   CDCIM_TEST_NODE_DIR=/opt/node22   pre-install this Node.js 22 directory (when deb.nodesource.com is not reachable)
#   https_proxy / no_proxy      passed into the container
set -Eeuo pipefail
SRC="${CDCIM_TEST_SRC:-$(cd "$(dirname "$0")/.." && pwd)}"
KEEP=0; LEGACY_REF=""; ONLY_LEGACY=0
while [ $# -gt 1 ]; do case "$1" in --keep) KEEP=1 ;; --legacy-ref) LEGACY_REF="$2"; shift ;; --only-legacy) ONLY_LEGACY=1 ;; esac; shift; done
OUT="${1:?usage: $0 [--keep] [--legacy-ref REF] OUTDIR}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
IMAGE=nexora/noble-clean:24.04
NAME=nexora-installtest
PASS=0; FAIL=0
log() { printf '\n\033[1;34m### %s\033[0m\n' "$*" | tee -a "$OUT/summary.txt"; }
result() { # result PASS|FAIL text
  printf '%s  %s\n' "$1" "$2" | tee -a "$OUT/summary.txt"
  if [ "$1" = PASS ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
}
CA_ENV=(); [ -n "${CDCIM_TEST_CA:-}" ] && CA_ENV=(-e NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/test-proxy.crt)
vm() { docker exec -e "https_proxy=${https_proxy:-}" -e "HTTPS_PROXY=${https_proxy:-}" -e "no_proxy=${no_proxy:-}" -e "NO_PROXY=${no_proxy:-}" "${CA_ENV[@]}" "$NAME" bash -c "$1"; }
psqlvm() { vm "runuser -u postgres -- psql -qtAX -d crapplet_dcim -c \"$1\""; }

build_image() {
  docker image inspect "$IMAGE" >/dev/null 2>&1 && return
  log "Building a minimal Ubuntu 24.04 image with debootstrap"
  local root; root="$(mktemp -d)"
  debootstrap --variant=minbase --include=systemd,systemd-sysv,dbus,curl,ca-certificates,iproute2 noble "$root" http://archive.ubuntu.com/ubuntu >"$OUT/debootstrap.log" 2>&1
  tar -C "$root" -c . | docker import - "$IMAGE" >/dev/null
  rm -rf "$root"
}

start_vm() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  local net=()
  [ "${CDCIM_TEST_HOST_NETWORK:-0}" = 1 ] && net=(--network host)
  docker run -d --name "$NAME" --hostname nexora-vm "${net[@]}" --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock "$IMAGE" /sbin/init >/dev/null
  for _ in $(seq 1 30); do vm 'systemctl is-system-running 2>/dev/null' | grep -qE 'running|degraded' && break; sleep 1; done
  if [ -n "${CDCIM_TEST_CA:-}" ]; then docker cp "$CDCIM_TEST_CA" "$NAME:/usr/local/share/ca-certificates/test-proxy.crt"; vm 'update-ca-certificates >/dev/null 2>&1'; fi
  if [ -n "${CDCIM_TEST_NODE_DIR:-}" ]; then
    docker cp "$CDCIM_TEST_NODE_DIR" "$NAME:/opt/node22"
    # A copied Node directory may carry the build machine's npm settings (cache path); drop them.
    vm 'rm -f /opt/node22/etc/npmrc; ln -sf /opt/node22/bin/node /usr/bin/node; ln -sf /opt/node22/lib/node_modules/npm/bin/npm-cli.js /usr/bin/npm; ln -sf /opt/node22/lib/node_modules/npm/bin/npx-cli.js /usr/bin/npx'
  fi
  vm 'cat /etc/os-release | head -1; apt-get -v | head -1' >"$OUT/vm.txt"
}

copy_source() { # copy_source DIR-IN-VM [GITREF]
  local tmp; tmp="$(mktemp -d)"
  if [ -n "${2:-}" ]; then git -C "$SRC" archive "$2" | tar -x -C "$tmp"
  else (cd "$SRC" && git ls-files -co --exclude-standard -z | tar --null -T - -cf - | tar -x -C "$tmp"); fi
  vm "rm -rf $1 && mkdir -p $1"
  docker cp "$tmp/." "$NAME:$1"
  rm -rf "$tmp"
}

install_from() { # install_from DIR LOG [extra env]
  local t=$SECONDS
  vm "${3:-} CDCIM_SOURCE_DIR=$1 CDCIM_ADMIN_EMAIL=admin@vm.test CDCIM_ADMIN_NAME='Install Test' bash $1/scripts/install.sh" >"$OUT/$2" 2>&1
  local rc=$?
  echo "  ($((SECONDS - t)) s, exit $rc, log $2)" | tee -a "$OUT/summary.txt"
  return $rc
}

ADMIN_LOG=01-install.log
admin_password() { sed -n 's/.*Password: *\([^ ]*\).*/\1/p' "$OUT/$ADMIN_LOG" | head -1; }
acceptance() { # acceptance LOGNAME [--write]
  docker cp "$SRC/scripts/acceptance.mjs" "$NAME:/root/acceptance.mjs"
  vm "CDCIM_ACCEPT_EMAIL=admin@vm.test CDCIM_ACCEPT_PASSWORD='$(admin_password)' node /root/acceptance.mjs --url http://127.0.0.1:8080 ${2:-} --json /root/$1.json" >"$OUT/$1.log" 2>&1
}

trap '[ "$KEEP" = 1 ] || docker rm -f "$NAME" >/dev/null 2>&1; echo; echo "Results: $PASS passed, $FAIL failed (details in $OUT)"' EXIT

build_image
main_steps() {
start_vm
copy_source /src
log "1. Fresh install on $(head -1 "$OUT/vm.txt" | cut -d'"' -f2) (apt components: $(vm 'grep -h ^deb /etc/apt/sources.list 2>/dev/null | cut -d" " -f4- | head -1'))"
if install_from /src 01-install.log; then result PASS "fresh install"; else result FAIL "fresh install (see 01-install.log)"; tail -20 "$OUT/01-install.log"; exit 1; fi
grep -q "Enabling the Ubuntu 'universe'" "$OUT/01-install.log" && result PASS "installer enabled 'universe' on a minimal image" || true
vm 'systemctl is-active crapplet-dcim crapplet-dcim-worker postgresql redis-server' >/dev/null && result PASS "services active under systemd" || result FAIL "services active"
vm 'systemctl is-enabled crapplet-dcim-backup.timer crapplet-dcim-anchor.timer' >/dev/null && result PASS "backup and anchor timers enabled" || result FAIL "timers enabled"
[ "$(vm 'stat -c %U /opt/crapplet-dcim/app/apps/api/dist/main.js')" = root ] && result PASS "installed code owned by root (read-only to the service account)" || result FAIL "release ownership"
vm 'runuser -u cdcim -- touch /opt/crapplet-dcim/app/x 2>/dev/null' && result FAIL "service account can write the release" || result PASS "service account cannot write the release"
vm 'systemctl show crapplet-dcim -p NoNewPrivileges -p ProtectSystem -p CapabilityBoundingSet' >"$OUT/unit-hardening.txt"

log "2. Install check and acceptance"
sleep 20   # let the worker write its first heartbeat
vm 'crapplet-dcim doctor' >"$OUT/02-doctor.log" 2>&1 && result PASS "doctor: no failures ($(grep -c '^PASS' "$OUT/02-doctor.log") pass, $(grep -c '^WARN' "$OUT/02-doctor.log") warn)" || result FAIL "doctor (02-doctor.log)"
acceptance 03-acceptance --write && result PASS "acceptance read+write: $(tail -1 "$OUT/03-acceptance.log")" || result FAIL "acceptance (03-acceptance.log)"

log "3. Backup and restore drill"
vm 'crapplet-dcim anchor' >>"$OUT/04-backup.log" 2>&1
BK="$(vm 'crapplet-dcim backup --tag drill' 2>>"$OUT/04-backup.log")"
echo "$BK" >>"$OUT/04-backup.log"
[ -n "$BK" ] && result PASS "backup written: $(basename "$BK") ($(vm "stat -c %s $BK") bytes)" || result FAIL "backup"
vm "tar -xOf $BK payload.enc | head -c 4096 | grep -a -c 'CREATE TABLE\|audit_events'" >/dev/null 2>&1 && result FAIL "backup is readable without the key" || result PASS "backup content is encrypted"
BEFORE="$(psqlvm 'select count(*) from customers')"
psqlvm "insert into customers (org_id, name, code) select id, 'After-backup Ltd', 'AFTERBK' from organizations limit 1" >/dev/null
psqlvm "select count(*) from customers" >/dev/null
# A damaged copy is refused.
vm "cp $BK /root/damaged.cdcim-backup && printf 'X' | dd of=/root/damaged.cdcim-backup bs=1 seek=5000 conv=notrunc 2>/dev/null"
vm 'crapplet-dcim restore /root/damaged.cdcim-backup --yes' >"$OUT/05-restore-damaged.log" 2>&1 && result FAIL "damaged backup was restored" || { grep -q "changed or damaged" "$OUT/05-restore-damaged.log" && result PASS "damaged backup refused before anything changed" || result FAIL "damaged backup: unexpected error (05-restore-damaged.log)"; }
T=$SECONDS
vm "crapplet-dcim restore $BK --yes" >"$OUT/06-restore.log" 2>&1 && result PASS "restore completed in $((SECONDS - T)) s" || result FAIL "restore (06-restore.log)"
AFTER="$(psqlvm 'select count(*) from customers')"
[ "$AFTER" = "$BEFORE" ] && result PASS "data back to the backup state (customers $BEFORE, row added after the backup is gone)" || result FAIL "customers after restore: $AFTER, expected $BEFORE"
grep -q '^PASS audit' "$OUT/06-restore.log" && result PASS "audit chain and anchors verified after restore" || result FAIL "audit after restore (06-restore.log)"
acceptance 07-acceptance-after-restore && result PASS "acceptance after restore: $(tail -1 "$OUT/07-acceptance-after-restore.log")" || result FAIL "acceptance after restore"

log "4. Upgrade"
R1="$(vm 'crapplet-dcim version')"
vm "echo '// upgrade test' >> /src/apps/web/index.html"
# The upgrade also adds a database migration, so the manual rollback below has to restore the database.
vm "cd /src/apps/api/drizzle && printf 'CREATE TABLE install_test_marker (id integer);\n' > 9999_install_test.sql && node -e '
  const f=\"meta/_journal.json\", j=JSON.parse(require(\"fs\").readFileSync(f));
  j.entries.push({ idx: j.entries.length, version: \"7\", when: Date.now(), tag: \"9999_install_test\", breakpoints: true });
  require(\"fs\").writeFileSync(f, JSON.stringify(j, null, 2));'"
MIG1="$(psqlvm 'select count(*) from drizzle.__drizzle_migrations')"
install_from /src 08-upgrade.log && result PASS "upgrade" || result FAIL "upgrade (08-upgrade.log)"
R2="$(vm 'crapplet-dcim version')"
[ "$R1" != "$R2" ] && result PASS "switched release $R1 → $R2" || result FAIL "release did not change"
grep -q 'pre-upgrade' "$OUT/08-upgrade.log" && result PASS "pre-upgrade backup taken" || result FAIL "no pre-upgrade backup"
acceptance 09-acceptance-after-upgrade && result PASS "acceptance after upgrade" || result FAIL "acceptance after upgrade"

log "5. Upgrade that cannot start → automatic rollback"
install_from /src 10-upgrade-broken.log CDCIM_FAIL_HEALTH=1 && result FAIL "broken upgrade reported success" || {
  grep -q 'rolled back' "$OUT/10-upgrade-broken.log" && result PASS "broken release detected and rolled back" || result FAIL "no rollback (10-upgrade-broken.log)"; }
[ "$(vm 'crapplet-dcim version')" = "$R2" ] && result PASS "running release is still $R2" || result FAIL "running release changed"
vm 'curl -fsS http://127.0.0.1:8080/api/v1/health/ready' >/dev/null && result PASS "service healthy after the automatic rollback" || result FAIL "service down after rollback"

log "6. Manual rollback"
vm 'crapplet-dcim rollback --yes' >"$OUT/11-rollback.log" 2>&1 && result PASS "rollback command" || result FAIL "rollback (11-rollback.log)"
[ "$(vm 'crapplet-dcim version')" = "$R1" ] && result PASS "back on $R1" || result FAIL "release after rollback: $(vm 'crapplet-dcim version')"
grep -q 'changed the database' "$OUT/11-rollback.log" && result PASS "rollback restored the pre-upgrade database (the upgrade had added a migration)" || result FAIL "rollback did not restore the database"
[ "$(psqlvm 'select count(*) from drizzle.__drizzle_migrations')" = "$MIG1" ] && [ -z "$(psqlvm "select 1 from pg_tables where tablename='install_test_marker'")" ] && result PASS "schema back to $MIG1 migrations, the upgrade's table is gone" || result FAIL "schema after rollback"
acceptance 12-acceptance-after-rollback && result PASS "acceptance after rollback" || result FAIL "acceptance after rollback"

log "7. Restart (reboot)"
docker restart "$NAME" >/dev/null
for _ in $(seq 1 60); do vm 'curl -fsS http://127.0.0.1:8080/api/v1/health/ready' >/dev/null 2>&1 && break; sleep 2; done
vm 'curl -fsS http://127.0.0.1:8080/api/v1/health/ready' >/dev/null 2>&1 && result PASS "service back after restart" || result FAIL "service not back after restart"
sleep 20
vm 'crapplet-dcim doctor' >"$OUT/13-doctor-after-restart.log" 2>&1 && result PASS "doctor after restart: no failures" || result FAIL "doctor after restart (13-doctor-after-restart.log)"

}
[ "$ONLY_LEGACY" = 1 ] || main_steps

if [ -n "$LEGACY_REF" ]; then
  log "8. Upgrade from an install made by the previous installer ($LEGACY_REF)"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  start_vm
  # The previous installer needs 'universe' already enabled, as on a standard Ubuntu Server.
  vm "sed -i 's/ main\$/ main universe/' /etc/apt/sources.list"
  copy_source /legacy "$LEGACY_REF"
  copy_source /src
  # Like a typical early install: reachable by IP over plain HTTP.
  vm "CDCIM_SOURCE_DIR=/legacy CDCIM_ADMIN_EMAIL=admin@vm.test CDCIM_BIND=0.0.0.0 CDCIM_INSECURE_HTTP=1 bash /legacy/scripts/install.sh" >"$OUT/14-legacy-install.log" 2>&1 && result PASS "previous installer ($LEGACY_REF) installed" || result FAIL "previous installer (14-legacy-install.log)"
  psqlvm "insert into customers (org_id, name, code) select id, 'Legacy Customer', 'LEGACY1' from organizations limit 1" >/dev/null
  install_from /src 15-legacy-upgrade.log && result PASS "upgrade from the previous layout" || result FAIL "legacy upgrade (15-legacy-upgrade.log)"
  vm 'test -L /opt/crapplet-dcim/app && ls /opt/crapplet-dcim/releases' >"$OUT/15-releases.txt" && result PASS "converted to the release layout: $(tr '\n' ' ' <"$OUT/15-releases.txt")" || result FAIL "release layout"
  [ "$(psqlvm "select count(*) from customers where code='LEGACY1'")" = 1 ] && result PASS "data kept across the upgrade" || result FAIL "data lost in the upgrade"
  sleep 20
  vm 'crapplet-dcim doctor' >"$OUT/16-legacy-doctor.log" 2>&1 && result PASS "doctor after the legacy upgrade: no failures" || result FAIL "doctor after legacy upgrade (16-legacy-doctor.log)"
  ADMIN_LOG=14-legacy-install.log
  acceptance 17-legacy-acceptance --write && result PASS "acceptance after the legacy upgrade: $(tail -1 "$OUT/17-legacy-acceptance.log")" || result FAIL "acceptance after legacy upgrade (17-legacy-acceptance.log)"

  log "9. Moving that install to HTTPS behind nginx (CDCIM_DOMAIN, self-signed certificate)"
  install_from /src 18-https-upgrade.log "CDCIM_DOMAIN=dcim.test CDCIM_TLS=selfsigned" && result PASS "upgrade with CDCIM_DOMAIN" || result FAIL "HTTPS upgrade (18-https-upgrade.log)"
  vm "grep -q dcim.test /etc/hosts || echo '127.0.0.1 dcim.test' >> /etc/hosts"
  [ "$(vm "sed -n 's/^HOST=//p' /etc/crapplet-dcim/api.env")" = 127.0.0.1 ] && ! vm 'grep -q COOKIE_SECURE=false /etc/crapplet-dcim/api.env' && result PASS "service moved to loopback with secure cookies" || result FAIL "configuration not switched"
  vm 'curl --noproxy "*" -s -o /dev/null -w "%{http_code}" http://dcim.test/' | grep -q 301 && result PASS "http:// redirects to https://" || result FAIL "no redirect"
  vm 'curl --noproxy "*" -skI https://dcim.test/' >"$OUT/19-https-headers.txt"
  grep -qi '^content-security-policy:.*font-src' "$OUT/19-https-headers.txt" && grep -qi '^strict-transport-security' "$OUT/19-https-headers.txt" && grep -qi '^x-content-type-options' "$OUT/19-https-headers.txt" && result PASS "security headers on the app page (HSTS, CSP, nosniff)" || result FAIL "security headers (19-https-headers.txt)"
  docker cp "$SRC/scripts/acceptance.mjs" "$NAME:/root/acceptance.mjs"
  vm "NODE_TLS_REJECT_UNAUTHORIZED=0 CDCIM_ACCEPT_EMAIL=admin@vm.test CDCIM_ACCEPT_PASSWORD='$(admin_password)' node /root/acceptance.mjs --url https://dcim.test --write" >"$OUT/20-https-acceptance.log" 2>&1 && result PASS "acceptance over HTTPS: $(tail -1 "$OUT/20-https-acceptance.log")" || result FAIL "acceptance over HTTPS (20-https-acceptance.log)"
  sleep 20
  vm 'crapplet-dcim doctor' >"$OUT/21-https-doctor.log" 2>&1 && result PASS "doctor over HTTPS: no failures ($(grep -c '^WARN' "$OUT/21-https-doctor.log") warnings)" || result FAIL "doctor (21-https-doctor.log)"
fi
[ "$FAIL" -eq 0 ]
