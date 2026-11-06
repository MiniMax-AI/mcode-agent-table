import {
  appendFileSync, closeSync, existsSync, fstatSync, ftruncateSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, truncateSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Entry, TableConfig } from './protocol.js';

/** JSONL persistence: <dir>/<table>.config.json, <table>.ledger.jsonl, <table>.tokens.json (hashes only). */
export class JsonlStore {
  constructor(readonly dir: string) { mkdirSync(dir, { recursive: true }); }
  private p(id: string, ext: string) { return join(this.dir, `${encodeURIComponent(id)}.${ext}`); }
  saveConfig(cfg: TableConfig) { writeFileSync(this.p(cfg.id, 'config.json'), JSON.stringify(cfg, null, 2)); }
  /**
   * Appending goes through the file description, not appendFileSync: an interrupted append can
   * leave the file ending in a half-written line, and a blind append at EOF would glue the new
   * entry onto that fragment, leaving one line that no repair can read. The tail is repaired
   * first, then the entry is written.
   */
  ledger(id: string) {
    const file = this.p(id, 'ledger.jsonl');
    return { append: (e: Entry) => { this.appendEntry(file, e); } };
  }
  load(id: string): { cfg: TableConfig; entries: Entry[]; tokens: Record<string, string> } {
    const cfg = JSON.parse(readFileSync(this.p(id, 'config.json'), 'utf8'));
    const lf = this.p(id, 'ledger.jsonl');
    const entries = existsSync(lf) ? this.readLedger(lf) : [];
    const tf = this.p(id, 'tokens.json');
    return { cfg, entries, tokens: existsSync(tf) ? JSON.parse(readFileSync(tf, 'utf8')) : {} };
  }
  /**
   * What follows the final newline of a ledger: nothing, a whole entry that only lost its
   * newline, or a fragment of an interrupted write. load and append share this one rule, so the
   * two cannot drift apart.
   */
  private classifyTail(buf: Buffer): { cut: number; state: 'empty' | 'complete' | 'partial'; entry?: Entry } {
    const cut = buf.lastIndexOf(0x0a) + 1;
    const tail = buf.subarray(cut);
    if (!tail.length) return { cut, state: 'empty' };
    try {
      return { cut, state: 'complete', entry: JSON.parse(tail.toString('utf8')) as Entry };
    } catch {
      return { cut, state: 'partial' };
    }
  }
  /**
   * A crash or a full disk can leave the last append half-written. Whatever follows the final
   * newline never formed a complete entry: if it does not parse, it is cut off the file, because
   * the next append would otherwise glue a new entry onto the fragment. A tail that does parse is
   * a complete entry that only lost its newline, so it is kept and the file is terminated.
   * Everything before the tail still throws: a corrupt line in the middle is not a torn write.
   */
  private readLedger(file: string): Entry[] {
    // Byte offsets, not string offsets: a torn write can end inside a multi-byte character,
    // and decoding first would replace that byte with U+FFFD and shift every length after it.
    const buf = readFileSync(file);
    const { cut, state, entry } = this.classifyTail(buf);
    const entries = buf.subarray(0, cut).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    if (state === 'empty') return entries;
    if (state === 'complete') {
      try {
        appendFileSync(file, '\n');
        entries.push(entry as Entry);
        return entries;
      } catch {
        // The entry could not be terminated, so it is not part of the ledger: drop it on both sides.
      }
    }
    truncateSync(file, cut);
    console.warn(`byob: dropped an incomplete trailing line from ${file}`);
    return entries;
  }
  /**
   * Append one entry, repairing a torn tail first. The file is opened once ('a+' = O_APPEND,
   * created when missing, like appendFileSync) so the repair and the write share a single file
   * description: a failed write is rolled back with ftruncateSync on that same fd, never by
   * re-opening the path.
   */
  private appendEntry(file: string, e: Entry): void {
    const fd = openSync(file, 'a+');
    let failure: unknown;
    try {
      this.appendTo(fd, file, e);
    } catch (err) {
      failure = err;
      throw err;
    } finally {
      // A close failure must not replace the error that made the append fail.
      try { closeSync(fd); } catch (err) { if (failure === undefined) throw err; }
    }
  }
  /**
   * The append itself, on an open description. A ledger that does not end on a newline is
   * repaired first: a fragment is cut off, because the new entry must not be glued onto it, while
   * a whole entry that this table never applied is refused, because appending after it would let
   * the table and its ledger disagree forever.
   */
  private appendTo(fd: number, file: string, e: Entry): void {
    const size = fstatSync(fd).size;
    let from = size; // where this append started, so a failed write can be rolled back
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) {
        // An empty tail is impossible here: the last byte is not a newline.
        const { cut, state } = this.classifyTail(this.readAll(fd, size));
        if (state === 'complete') {
          // The bytes of a whole entry are on disk but the table never applied it. Refuse until a
          // restart replays the ledger. No path in this message: it is handed to API clients.
          throw new Error('byob: ledger ends in a line this table has not applied; restart to replay the ledger');
        }
        ftruncateSync(fd, cut);
        console.warn(`byob: dropped an incomplete trailing line from ${file}`);
        from = cut;
      }
    }
    const data = Buffer.from(JSON.stringify(e) + '\n', 'utf8');
    try {
      this.writeAll(fd, data);
    } catch (err) {
      // Roll back to where this call started: a failed append must leave no bytes behind, or the
      // next append would find a fragment of this one.
      try { ftruncateSync(fd, from); } catch { /* keep the original error */ }
      throw err;
    }
  }
  /** writeSync may write fewer bytes than asked for; keep going until the entry is fully down. */
  private writeAll(fd: number, data: Buffer): void {
    let off = 0;
    while (off < data.length) {
      const n = writeSync(fd, data, off, data.length - off);
      if (n <= 0) throw new Error('byob: ledger write made no progress');
      off += n;
    }
  }
  /** Read the whole file through the open description, so the repair needs no second open. */
  private readAll(fd: number, size: number): Buffer {
    const buf = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buf, read, size - read, read);
      if (n <= 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  }
  saveTokens(id: string, tokens: Record<string, string>) { writeFileSync(this.p(id, 'tokens.json'), JSON.stringify(tokens), { mode: 0o600 }); }
  /** True when anything is stored under this id, including a table that failed to load. */
  has(id: string) { return existsSync(this.p(id, 'config.json')) || existsSync(this.p(id, 'ledger.jsonl')); }
  tables(): string[] { return readdirSync(this.dir).filter(f => f.endsWith('.config.json')).map(f => decodeURIComponent(f.slice(0, -'.config.json'.length))); }
}
