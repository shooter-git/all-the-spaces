/** Just enough of the tar format for the supervisor: writing files in, reading one file out. */

const block = 512;

function header(name: string, size: number, mode = 0o644) {
  const h = Buffer.alloc(block);
  const put = (text: string, offset: number, length: number) =>
    h.write(text, offset, length, 'utf8');
  const octal = (n: number, length: number) => `${n.toString(8).padStart(length - 1, '0')}\0`;
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', 154);
    if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100)
      throw new Error(`Path too long: ${name}`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  put(base, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(2000, 8), 108, 8); // uid: the sandbox's user
  put(octal(2000, 8), 116, 8); // gid
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

/** A tar archive of files (paths relative, no directories needed). */
export function pack(files: Map<string, Uint8Array>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, data] of files) {
    if (name.startsWith('/') || name.split('/').includes('..'))
      throw new Error(`Unsafe path: ${name}`);
    parts.push(header(name, data.byteLength), Buffer.from(data));
    const pad = (block - (data.byteLength % block)) % block;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(block * 2));
  return Buffer.concat(parts);
}

/** Every regular file in a tar archive, by path. */
export function unpack(tar: Buffer, limit = 256 * 1024 * 1024): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  let total = 0;
  let longName: string | null = null;
  // A pax extended header ('x') gives the next entry's real path when it's too long for ustar
  // (git archive, and so GitHub's archives, write these). Global ones ('g') are ignored.
  const paxPath = (data: Buffer) => {
    for (const record of data.toString('utf8').split('\n')) {
      const m = /^\d+ path=(.*)$/.exec(record);
      if (m) return m[1] ?? null;
    }
    return null;
  };
  while (offset + block <= tar.length) {
    const h = tar.subarray(offset, offset + block);
    if (h.every((b) => b === 0)) break;
    const field = (start: number, length: number) =>
      h
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const prefix = field(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = null;
    const data = tar.subarray(offset + block, offset + block + size);
    if (type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '');
    else if (type === 'x') longName = paxPath(data);
    else if (type === '0' || type === '\0') {
      name = name.replace(/^\.\//, '');
      total += size;
      if (total > limit) throw new Error('Archive too large');
      files.set(name, Buffer.from(data));
    }
    offset += block + Math.ceil(size / block) * block;
  }
  return files;
}
