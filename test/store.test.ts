import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlStore } from '../src/store.js';
import { TableHost } from '../src/host.js';
import { cfg } from './helpers.js';

/**
 * Only writeSync is faked, so the rest of node:fs stays real. The flag is hoisted together with
 * the mock: a vi.mock factory runs before the module body, so it cannot close over a plain `let`.
 */
const fsMock = vi.hoisted(() => ({ writeSync: 'off' as 'off' | 'throw' | 'short' | 'half' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeSync(fd: number, data: string | NodeJS.ArrayBufferView, ...rest: unknown[]) {
      if (fsMock.writeSync === 'throw') {
        const err = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      }
      if (fsMock.writeSync === 'half' && typeof data !== 'string') {
        // One byte lands, then the disk is full: the append must roll that byte back.
        fsMock.writeSync = 'off';
        actual.writeSync(fd, data as Buffer, 0, 1);
        const err = new Error('ENOSPC: no space left on device, write') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        throw err;
      }
      if (fsMock.writeSync === 'short' && typeof data !== 'string') {
        fsMock.writeSync = 'off';
        const buf = data as Buffer;
        const offset = (rest[0] as number | undefined) ?? 0;
        const length = (rest[1] as number | undefined) ?? buf.length - offset;
        const position = rest[2] as number | undefined;
        return actual.writeSync(fd, buf, offset, length - 1, position);
      }
      return (actual.writeSync as (...a: unknown[]) => number)(fd, data, ...rest);
    },
  };
});

afterEach(() => { fsMock.writeSync = 'off'; });

const opened = (id: string) => JSON.stringify({
  seq: 1, table: id, seat: 'core', kind: 'system', event: 'table_opened', body: 'test topic', ts: '2026-01-01T00:00:00.000Z',
});
const say = (id: string, seq: number) => ({
  seq, table: id, seat: 'a', kind: 'say', body: 'x', ts: '2026-01-01T00:00:01.000Z',
});
const ledgerPath = (dir: string, id: string) => join(dir, `${id}.ledger.jsonl`);

function table(dir: string, id: string, ledger: string) {
  writeFileSync(join(dir, `${id}.config.json`), JSON.stringify(cfg(id, { kind: 'broadcast', order: ['a'] })));
  writeFileSync(ledgerPath(dir, id), ledger);
}
const parses = (text: string) => () => text.split('\n').filter(Boolean).forEach(l => JSON.parse(l));

describe('ledger durability', () => {
  it('keeps the table and cuts the half-written last line when an append was interrupted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byob-store-'));
    table(dir, 't', opened('t') + '\n{"seq":2,"table":"t","sea');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const host = new TableHost(new JsonlStore(dir));

    expect(host.tables.has('t')).toBe(true);
    expect(host.get('t').entries.map(e => e.seq)).toEqual([1]);
    const text = readFileSync(ledgerPath(dir, 't'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(parses(text)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/^byob: dropped an incomplete trailing line from /);
    warn.mockRestore();
  });

  it('keeps a complete last entry that only lost its newline, and terminates the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byob-store-'));
    table(dir, 't', opened('t') + '\n' + JSON.stringify(say('t', 2)));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { entries } = new JsonlStore(dir).load('t');

    expect(entries.map(e => e.seq)).toEqual([1, 2]);
    expect(readFileSync(ledgerPath(dir, 't'), 'utf8').endsWith('\n')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still refuses a corrupt line in the middle instead of trimming the ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byob-store-'));
    table(dir, 't', opened('t') + '\n{"not":"an entry"\n' + JSON.stringify(say('t', 3)));
    const before = readFileSync(ledgerPath(dir, 't'), 'utf8');

    expect(() => new JsonlStore(dir).load('t')).toThrow();
    expect(readFileSync(ledgerPath(dir, 't'), 'utf8')).toBe(before);
  });

  it('appends cleanly after a repair, so the fragment cannot swallow the next entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byob-store-'));
    table(dir, 't', opened('t') + '\n{"seq":2,"table":"t","sea');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new JsonlStore(dir);
    store.load('t');

    store.ledger('t').append(say('t', 2) as never);

    expect(new JsonlStore(dir).load('t').entries.map(e => e.seq)).toEqual([1, 2]);
    warn.mockRestore();
  });

  it('cuts at a byte boundary when the interrupted write ended inside a multi-byte character', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byob-store-'));
    const good = JSON.stringify({ ...JSON.parse(opened('t')), body: '话题 讨论' }) + '\n';
    writeFileSync(join(dir, 't.config.json'), JSON.stringify(cfg('t', { kind: 'broadcast', order: ['a'] })));
    writeFileSync(ledgerPath(dir, 't'), Buffer.concat([
      Buffer.from(good, 'utf8'),
      Buffer.from('{"seq":2,"body":"', 'utf8'),
      Buffer.from([0xe4, 0xb8]), // first two bytes of a three-byte character
    ]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { entries } = new JsonlStore(dir).load('t');

    expect(entries.map(e => e.seq)).toEqual([1]);
    expect(readFileSync(ledgerPath(dir, 't')).equals(Buffer.from(good, 'utf8'))).toBe(true);
    warn.mockRestore();
  });

  it('does not glue a new entry onto a torn tail in the same process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byob-store-'));
    table(dir, 't', opened('t') + '\n{"seq":2,"table":"t","sea');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    new JsonlStore(dir).ledger('t').append(say('t', 2) as never);

    const text = readFileSync(ledgerPath(dir, 't'), 'utf8');
    expect(parses(text)).not.toThrow();
    expect(text.endsWith('\n')).toBe(true);
    expect(new JsonlStore(dir).load('t').entries.map(e => e.seq)).toEqual([1, 2]);
    warn.mockRestore();
  });

  it('leaves nothing behind when the append itself fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byob-store-'));
    table(dir, 't', opened('t') + '\n');
    const store = new JsonlStore(dir);
    fsMock.writeSync = 'throw';

    expect(() => store.ledger('t').append(say('t', 2) as never)).toThrow(/ENOSPC/);

    const after = readFileSync(ledgerPath(dir, 't'));
    expect(after[after.length - 1]).toBe(0x0a);
    expect(parses(after.toString('utf8'))).not.toThrow();
    expect(after.toString('utf8')).toBe(opened('t') + '\n');

    fsMock.writeSync = 'off';
    store.ledger('t').append(say('t', 2) as never);

    expect(new JsonlStore(dir).load('t').entries.map(e => e.seq)).toEqual([1, 2]);
  });

  it('rolls back the byte a write manages to put down before the disk fills', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byob-store-'));
    table(dir, 't', opened('t') + '\n');
    const before = readFileSync(ledgerPath(dir, 't'));
    fsMock.writeSync = 'half';

    expect(() => new JsonlStore(dir).ledger('t').append(say('t', 2) as never)).toThrow(/ENOSPC/);

    expect(readFileSync(ledgerPath(dir, 't')).equals(before)).toBe(true);
    new JsonlStore(dir).ledger('t').append(say('t', 2) as never);
    expect(new JsonlStore(dir).load('t').entries.map(e => e.seq)).toEqual([1, 2]);
  });

  it('refuses to append while the ledger ends in a complete entry the table has not applied', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byob-store-'));
    table(dir, 't', opened('t') + '\n' + JSON.stringify(say('t', 2)));
    const before = readFileSync(ledgerPath(dir, 't'));
    const store = new JsonlStore(dir);

    let message = '';
    try { store.ledger('t').append(say('t', 3) as never); } catch (err) { message = (err as Error).message; }
    expect(message).toMatch(/restart to replay/);
    expect(message).not.toContain(dir); // the message reaches API clients, so it carries no path
    expect(readFileSync(ledgerPath(dir, 't')).equals(before)).toBe(true);

    let again = '';
    try { store.ledger('t').append(say('t', 3) as never); } catch (err) { again = (err as Error).message; }
    expect(again).toMatch(/restart to replay/);
    expect(readFileSync(ledgerPath(dir, 't')).equals(before)).toBe(true);
  });

  it('completes a short write instead of returning early', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byob-store-'));
    const e = say('t', 1);
    fsMock.writeSync = 'short';

    new JsonlStore(dir).ledger('t').append(e as never);

    expect(readFileSync(ledgerPath(dir, 't')).equals(Buffer.from(JSON.stringify(e) + '\n', 'utf8'))).toBe(true);
  });

  it('repairs a ledger whose only line is torn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byob-store-'));
    table(dir, 't', '{"seq":2,"table":"t","sea');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    new JsonlStore(dir).ledger('t').append(say('t', 2) as never);

    const after = readFileSync(ledgerPath(dir, 't'));
    expect(after[after.length - 1]).toBe(0x0a);
    expect(new JsonlStore(dir).load('t').entries.map(e => e.seq)).toEqual([2]);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('appends without a prior load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byob-store-'));
    const store = new JsonlStore(dir);
    store.saveConfig(cfg('t', { kind: 'broadcast', order: ['a'] }));

    expect(store.ledger('t').append(say('t', 1) as never)).toBeUndefined();

    expect(store.load('t').entries.map(e => e.seq)).toEqual([1]);
    expect(readFileSync(ledgerPath(dir, 't'), 'utf8').endsWith('\n')).toBe(true);
  });
});
