/**
 * Minimal "newc" cpio framing, used to hand the Proxmox VE installer its ISO
 * inside the initrd (the kernel unpacks every archive appended to the initrd,
 * compressed or not, and the installer looks for /proxmox.iso there). Only the
 * header and trailer are built here; the file data is streamed from disk.
 */

const pad4 = (n: number) => (4 - (n % 4)) % 4;
const hex = (n: number) => n.toString(16).padStart(8, '0');

/** Header (with name and padding) for one regular file of `size` bytes. */
export function cpioFileHeader(name: string, size: number, ino = 1, mtime = 0): Buffer {
  if (size > 0xffffffff) throw new Error('cpio newc entries are limited to 4 GiB');
  const nameBuf = Buffer.from(`${name}\0`, 'utf8');
  const fields = [ino, 0o100644, 0, 0, 1, mtime, size, 0, 0, 0, 0, nameBuf.length, 0];
  const head = Buffer.from(`070701${fields.map(hex).join('')}`, 'ascii');
  return Buffer.concat([head, nameBuf, Buffer.alloc(pad4(head.length + nameBuf.length))]);
}

/** Padding after `size` bytes of file data. */
export function cpioDataPadding(size: number): Buffer {
  return Buffer.alloc(pad4(size));
}

export function cpioTrailer(): Buffer {
  return cpioFileHeader('TRAILER!!!', 0, 0);
}
