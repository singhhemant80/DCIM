# NexoraDC network boot (PXE)

`ipxe/` holds iPXE **v2.0.0** built from source with `nexora-embed.ipxe` as
its embedded script (`scripts/build-ipxe.sh` rebuilds them; `ipxe/SHA256SUMS`
lists the result):

| File | For |
|---|---|
| `undionly.kpxe` | Legacy BIOS servers (also served as `undionly.0` for proxy DHCP) |
| `snponly.efi` | UEFI servers (uses the firmware's own NIC driver) |
| `ipxe.efi` | UEFI servers whose firmware network stack is unusable with `snponly.efi` |

The embedded script gets an address and fetches `nexora.ipxe` over TFTP from
the NexoraDC PXE service: the proxy-DHCP server's address (proxy mode), else
the DHCP "next server". `nexora.ipxe` is written by the PXE helper and chains
to `<boot URL>/api/v1/boot/ipxe?mac=…`; NexoraDC answers only a MAC with an
active network install and sends every other server to its next boot device.

How the pieces fit:

1. The worker writes `CDCIM_PXE_DIR/desired.json` (settings + active MACs).
2. `crapplet-dcim-pxe-apply` (root, started by a systemd path unit and a
   1-minute timer) validates that file strictly, renders dnsmasq's
   configuration, the host list and the TFTP directory into
   `/var/lib/crapplet-dcim-pxe`, and restarts or reloads `crapplet-dcim-pxe`.
3. `crapplet-dcim-pxe` is dnsmasq (DNS off): proxy DHCP, DHCP or TFTP only,
   answering only the MACs in the host list.

Tested: the full chain in QEMU (legacy BIOS and UEFI/OVMF) with real dnsmasq
in proxy mode (with a separate DHCP server) and DHCP mode, a real Linux kernel
and a test initramfs that fetches its autoinstall configuration and reports
back. Not yet tested on a physical server.
