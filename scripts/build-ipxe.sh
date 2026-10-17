#!/usr/bin/env bash
# Rebuilds the iPXE binaries in deploy/pxe/ipxe from source, with the NexoraDC
# boot script (deploy/pxe/nexora-embed.ipxe) built in. Needs git, gcc, make and
# liblzma-dev. The result replaces the committed binaries and SHA256SUMS.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${IPXE_TAG:-v2.0.0}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git clone --quiet https://github.com/ipxe/ipxe.git "$WORK/ipxe"
git -C "$WORK/ipxe" checkout --quiet "$TAG"
make -C "$WORK/ipxe/src" -j"$(nproc)" NO_WERROR=1 EMBED="$ROOT/deploy/pxe/nexora-embed.ipxe" \
  bin/undionly.kpxe bin-x86_64-efi/snponly.efi bin-x86_64-efi/ipxe.efi
cp "$WORK/ipxe/src/bin/undionly.kpxe" "$WORK/ipxe/src/bin-x86_64-efi/snponly.efi" "$WORK/ipxe/src/bin-x86_64-efi/ipxe.efi" "$ROOT/deploy/pxe/ipxe/"
(cd "$ROOT/deploy/pxe/ipxe" && sha256sum undionly.kpxe snponly.efi ipxe.efi > SHA256SUMS)
echo "Built iPXE $TAG with the NexoraDC boot script into deploy/pxe/ipxe"
