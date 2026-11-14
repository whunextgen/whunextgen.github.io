// 在浏览器里读 .xls（Excel 97-2003，BIFF8）的第一张表，只取单元格里的文字和数字。
// 学校财务系统导出的就是这种格式；文件只在浏览器里读，不上传。不支持公式重算、日期格式和加密文件。

const END = 0xfffffffe;

// 从 OLE2 复合文件里取出 Workbook 流
function workbook(buf: ArrayBuffer): Uint8Array {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (u8.length < 512 || sig.some((b, i) => u8[i] !== b)) throw new Error('不是 Excel 97-2003（.xls）文件');
  const ssz = 1 << dv.getUint16(30, true), msz = 1 << dv.getUint16(32, true);
  const nfat = dv.getUint32(44, true), dir0 = dv.getUint32(48, true), miniCut = dv.getUint32(56, true), mfat0 = dv.getUint32(60, true);
  let difatNext = dv.getUint32(68, true), ndifat = dv.getUint32(72, true);
  const off = (n: number) => 512 + n * ssz;
  const difat: number[] = []; for (let i = 0; i < 109; i++) difat.push(dv.getUint32(76 + 4 * i, true));
  while (difatNext < END && ndifat-- > 0) { const o = off(difatNext); for (let i = 0; i < ssz / 4 - 1; i++) difat.push(dv.getUint32(o + 4 * i, true)); difatNext = dv.getUint32(o + ssz - 4, true); }
  const fat: number[] = [];
  for (const s of difat.slice(0, nfat)) if (s < END) for (let i = 0; i < ssz / 4; i++) fat.push(dv.getUint32(off(s) + 4 * i, true));
  const chain = (start: number, table: number[], size: number, at: (n: number) => Uint8Array) => {
    const parts: Uint8Array[] = []; let n = start, guard = 0;
    while (n < END && guard++ < 1e6) { parts.push(at(n)); n = table[n]; }
    const out = new Uint8Array(parts.length * size); parts.forEach((p, i) => out.set(p, i * size)); return out;
  };
  const sector = (n: number) => u8.subarray(off(n), off(n) + ssz);
  const dir = chain(dir0, fat, ssz, sector), ddv = new DataView(dir.buffer);
  let root = { start: 0, size: 0 }, book: { start: number; size: number } | null = null;
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nl = ddv.getUint16(o + 64, true); if (!nl) continue;
    const name = new TextDecoder('utf-16le').decode(dir.subarray(o, o + nl - 2)), type = dir[o + 66];
    const ent = { start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true) };
    if (type === 5) root = ent; else if (type === 2 && (name === 'Workbook' || name === 'Book')) book = ent;
  }
  if (!book) throw new Error('文件中没有工作簿');
  if (book.size >= miniCut) return chain(book.start, fat, ssz, sector).subarray(0, book.size);
  const mini = chain(root.start, fat, ssz, sector), mf = chain(mfat0, fat, ssz, sector), mdv = new DataView(mf.buffer);
  const mfat: number[] = []; for (let i = 0; i + 4 <= mf.length; i += 4) mfat.push(mdv.getUint32(i, true));
  return chain(book.start, mfat, msz, (n) => mini.subarray(n * msz, (n + 1) * msz)).subarray(0, book.size);
}

const rk = (v: number) => { let n: number;
  if (v & 2) n = v >> 2; else { const b = new DataView(new ArrayBuffer(8)); b.setUint32(4, v & 0xfffffffc, true); n = b.getFloat64(0, true); }
  return v & 1 ? n / 100 : n; };
const show = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1e6) / 1e6));

// 共享字符串表可能跨多条记录（SST 加若干 CONTINUE）；字符串在记录边界处续接时，续接部分开头有 1 个字节说明是否双字节
function sharedStrings(chunks: Uint8Array[]): string[] {
  let ci = 0, p = 8; const out: string[] = [];
  const left = () => chunks[ci].length - p;
  const next = () => { ci++; p = 0; };
  const byte = () => { if (left() <= 0) next(); return chunks[ci][p++]; };
  const u16 = () => byte() | (byte() << 8);
  const u32 = () => (u16() | (u16() << 16)) >>> 0;
  const skip = (n: number) => { while (n > 0) { if (left() <= 0) next(); const k = Math.min(n, left()); p += k; n -= k; } };
  const total = new DataView(chunks[0].buffer, chunks[0].byteOffset).getUint32(4, true);
  for (let i = 0; i < total && ci < chunks.length; i++) {
    if (left() <= 0 && ci + 1 >= chunks.length) break;
    let n = u16(); let flag = byte(); const rich = flag & 8 ? u16() : 0, ext = flag & 4 ? u32() : 0; let s = '';
    while (n > 0) {
      if (left() <= 0) { next(); flag = (flag & ~1) | (chunks[ci][p++] & 1); }
      const wide = flag & 1, take = Math.min(n, wide ? left() >> 1 : left());
      if (wide) { for (let k = 0; k < take; k++) s += String.fromCharCode(chunks[ci][p + 2 * k] | (chunks[ci][p + 2 * k + 1] << 8)); p += 2 * take; }
      else { for (let k = 0; k < take; k++) s += String.fromCharCode(chunks[ci][p + k]); p += take; }
      n -= take; if (take === 0 && left() > 0) break;
    }
    skip(4 * rich + ext); out.push(s);
  }
  return out;
}

export function readXls(buf: ArrayBuffer): string[][] {
  const wb = workbook(buf), dv = new DataView(wb.buffer, wb.byteOffset, wb.byteLength);
  let pos = 0, sheet = -1, sst: string[] = [], sstChunks: Uint8Array[] | null = null, last = 0;
  const cells = new Map<number, Map<number, string>>();
  const put = (r: number, c: number, v: string) => { if (sheet !== 0) return; if (!cells.has(r)) cells.set(r, new Map()); cells.get(r)!.set(c, v); };
  const str = (o: number, lenBytes: number) => { const n = lenBytes === 2 ? dv.getUint16(o, true) : dv.getUint8(o); const f = dv.getUint8(o + lenBytes), b = o + lenBytes + 1 + (f & 8 ? 2 : 0) + (f & 4 ? 4 : 0);
    return f & 1 ? new TextDecoder('utf-16le').decode(wb.subarray(b, b + 2 * n)) : Array.from(wb.subarray(b, b + n), (x) => String.fromCharCode(x)).join(''); };
  while (pos + 4 <= wb.length) {
    const id = dv.getUint16(pos, true), len = dv.getUint16(pos + 2, true), o = pos + 4; pos = o + len;
    if (id === 0x003c && last === 0x00fc && sstChunks) { sstChunks.push(wb.subarray(o, o + len)); continue; }
    if (sstChunks && id !== 0x003c) { sst = sharedStrings(sstChunks); sstChunks = null; }
    last = id === 0x003c ? last : id;
    if (id === 0x0809) { if (dv.getUint16(o + 2, true) === 0x0010) sheet++; }
    else if (id === 0x00fc) sstChunks = [wb.subarray(o, o + len)];
    else if (id === 0x00fd) put(dv.getUint16(o, true), dv.getUint16(o + 2, true), sst[dv.getUint32(o + 6, true)] ?? '');
    else if (id === 0x0203) put(dv.getUint16(o, true), dv.getUint16(o + 2, true), show(dv.getFloat64(o + 6, true)));
    else if (id === 0x027e) put(dv.getUint16(o, true), dv.getUint16(o + 2, true), show(rk(dv.getUint32(o + 6, true))));
    else if (id === 0x00bd) { const r = dv.getUint16(o, true), c = dv.getUint16(o + 2, true), n = (len - 6) / 6; for (let k = 0; k < n; k++) put(r, c + k, show(rk(dv.getUint32(o + 6 + 6 * k, true)))); }
    else if (id === 0x0204) put(dv.getUint16(o, true), dv.getUint16(o + 2, true), str(o + 6, 2));
    else if (id === 0x0006 && !(dv.getUint8(o + 12) === 0xff && dv.getUint8(o + 13) === 0xff)) put(dv.getUint16(o, true), dv.getUint16(o + 2, true), show(dv.getFloat64(o + 6, true)));
  }
  const rows = [...cells.keys()].sort((a, b) => a - b);
  const width = Math.max(0, ...rows.map((r) => Math.max(...cells.get(r)!.keys()) + 1));
  return rows.map((r) => Array.from({ length: width }, (_, c) => (cells.get(r)!.get(c) ?? '').replace(/\s+/g, ' ').trim()));
}
