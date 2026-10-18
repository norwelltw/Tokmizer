export type SqliteValue = null | number | bigint | string | Uint8Array;

export class SqliteReadError extends Error {}

type Db = { buf: Buffer; pageSize: number; usable: number; pageCount: number };

const MAGIC = "SQLite format 3\u0000";

function fail(message: string): never {
  throw new SqliteReadError(message);
}

function openDb(buf: Buffer): Db {
  if (buf.length < 100 || buf.toString("latin1", 0, 16) !== MAGIC) fail("not a SQLite database");
  const raw = buf.readUInt16BE(16);
  const pageSize = raw === 1 ? 65536 : raw;
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0) fail("invalid page size");
  const encoding = buf.readUInt32BE(56);
  if (encoding !== 0 && encoding !== 1) fail("only UTF-8 databases can be read");
  const usable = pageSize - buf[20]!;
  if (usable < 480) fail("invalid reserved space");
  return { buf, pageSize, usable, pageCount: Math.floor(buf.length / pageSize) };
}

function varint(buf: Buffer, pos: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 8; i += 1) {
    if (pos + i >= buf.length) fail("truncated varint");
    const byte = buf[pos + i]!;
    value = value * 128 + (byte & 0x7f);
    if (byte < 0x80) return [value, pos + i + 1];
  }
  if (pos + 8 >= buf.length) fail("truncated varint");
  return [value * 256 + buf[pos + 8]!, pos + 9];
}

function pageStart(db: Db, page: number): number {
  if (!Number.isInteger(page) || page < 1 || page > db.pageCount) fail("page out of range");
  return (page - 1) * db.pageSize;
}

function payload(db: Db, pos: number, size: number): Buffer {
  const maxLocal = db.usable - 35;
  if (size <= maxLocal) {
    if (pos + size > db.buf.length) fail("truncated cell");
    return db.buf.subarray(pos, pos + size);
  }
  const minLocal = Math.floor(((db.usable - 12) * 32) / 255) - 23;
  const spill = minLocal + ((size - minLocal) % (db.usable - 4));
  const local = spill <= maxLocal ? spill : minLocal;
  const parts: Buffer[] = [db.buf.subarray(pos, pos + local)];
  let remaining = size - local;
  let next = db.buf.readUInt32BE(pos + local);
  const seen = new Set<number>();
  while (remaining > 0) {
    if (seen.has(next)) fail("overflow loop");
    seen.add(next);
    const start = pageStart(db, next);
    const take = Math.min(remaining, db.usable - 4);
    parts.push(db.buf.subarray(start + 4, start + 4 + take));
    remaining -= take;
    next = db.buf.readUInt32BE(start);
  }
  return Buffer.concat(parts);
}

function decodeRecord(rec: Buffer): SqliteValue[] {
  const [headerSize, first] = varint(rec, 0);
  if (headerSize > rec.length) fail("bad record header");
  const types: number[] = [];
  let pos = first;
  while (pos < headerSize) {
    const [type, next] = varint(rec, pos);
    types.push(type);
    pos = next;
  }
  let off = headerSize;
  const values: SqliteValue[] = [];
  const need = (n: number) => {
    if (off + n > rec.length) fail("truncated record");
  };
  for (const type of types) {
    if (type === 0) values.push(null);
    else if (type >= 1 && type <= 6) {
      const width = [0, 1, 2, 3, 4, 6, 8][type]!;
      need(width);
      if (type === 6) {
        const big = rec.readBigInt64BE(off);
        values.push(big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big);
      } else values.push(rec.readIntBE(off, width));
      off += width;
    } else if (type === 7) {
      need(8);
      values.push(rec.readDoubleBE(off));
      off += 8;
    } else if (type === 8 || type === 9) values.push(type - 8);
    else if (type >= 12) {
      const len = Math.floor((type - (type % 2 === 0 ? 12 : 13)) / 2);
      need(len);
      const slice = rec.subarray(off, off + len);
      values.push(type % 2 === 0 ? new Uint8Array(slice) : slice.toString("utf8"));
      off += len;
    } else fail("reserved serial type");
  }
  return values;
}

function walkTable(db: Db, root: number, onRow: (rowid: number, values: SqliteValue[]) => void): void {
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const page = stack.pop()!;
    if (seen.has(page)) fail("b-tree loop");
    seen.add(page);
    const base = pageStart(db, page);
    const header = base + (page === 1 ? 100 : 0);
    const kind = db.buf[header];
    const cells = db.buf.readUInt16BE(header + 3);
    if (kind === 0x05) {
      const children: number[] = [];
      for (let i = 0; i < cells; i += 1) {
        const cell = base + db.buf.readUInt16BE(header + 12 + i * 2);
        children.push(db.buf.readUInt32BE(cell));
      }
      children.push(db.buf.readUInt32BE(header + 8));
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]!);
    } else if (kind === 0x0d) {
      for (let i = 0; i < cells; i += 1) {
        const cell = base + db.buf.readUInt16BE(header + 8 + i * 2);
        const [size, afterSize] = varint(db.buf, cell);
        const [rowid, afterRowid] = varint(db.buf, afterSize);
        onRow(rowid, decodeRecord(payload(db, afterRowid, size)));
      }
    } else fail("unexpected page type");
  }
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "[") quote = "]";
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

const CONSTRAINT_START = /^(?:constraint|primary|unique|check|foreign)\b/i;

export function tableColumns(sql: string): { names: string[]; rowidAlias: number } {
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open < 0 || close <= open) fail("unreadable table definition");
  const names: string[] = [];
  let rowidAlias = -1;
  for (const def of splitTopLevel(sql.slice(open + 1, close))) {
    const trimmed = def.trim();
    if (!trimmed || CONSTRAINT_START.test(trimmed)) continue;
    const m = /^(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([^\s]+))/.exec(trimmed);
    if (!m) continue;
    const name = m[1] ?? m[2] ?? m[3] ?? m[4]!;
    if (rowidAlias < 0 && /\binteger\s+primary\s+key\b/i.test(trimmed)) rowidAlias = names.length;
    names.push(name);
  }
  return { names, rowidAlias };
}

export function scanSqliteTable(buf: Buffer, table: string, onRow: (row: Record<string, SqliteValue>) => void): number {
  const db = openDb(buf);
  let root = 0;
  let sql = "";
  walkTable(db, 1, (_rowid, values) => {
    if (values[0] === "table" && values[1] === table && typeof values[3] === "number" && typeof values[4] === "string") {
      root = values[3];
      sql = values[4];
    }
  });
  if (!root) fail(`no ${table} table`);
  const { names, rowidAlias } = tableColumns(sql);
  let count = 0;
  walkTable(db, root, (rowid, values) => {
    const row: Record<string, SqliteValue> = {};
    names.forEach((name, i) => {
      row[name] = i === rowidAlias && (values[i] ?? null) === null ? rowid : values[i] ?? null;
    });
    onRow(row);
    count += 1;
  });
  return count;
}
