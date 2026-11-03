import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Entry, TableConfig } from './protocol.js';

/** JSONL persistence: <dir>/<table>.config.json, <table>.ledger.jsonl, <table>.tokens.json (hashes only). */
export class JsonlStore {
  constructor(readonly dir: string) { mkdirSync(dir, { recursive: true }); }
  private p(id: string, ext: string) { return join(this.dir, `${encodeURIComponent(id)}.${ext}`); }
  saveConfig(cfg: TableConfig) { writeFileSync(this.p(cfg.id, 'config.json'), JSON.stringify(cfg, null, 2)); }
  ledger(id: string) { return { append: (e: Entry) => appendFileSync(this.p(id, 'ledger.jsonl'), JSON.stringify(e) + '\n') }; }
  load(id: string): { cfg: TableConfig; entries: Entry[]; tokens: Record<string, string> } {
    const cfg = JSON.parse(readFileSync(this.p(id, 'config.json'), 'utf8'));
    const lf = this.p(id, 'ledger.jsonl');
    const entries = existsSync(lf) ? readFileSync(lf, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const tf = this.p(id, 'tokens.json');
    return { cfg, entries, tokens: existsSync(tf) ? JSON.parse(readFileSync(tf, 'utf8')) : {} };
  }
  saveTokens(id: string, tokens: Record<string, string>) { writeFileSync(this.p(id, 'tokens.json'), JSON.stringify(tokens), { mode: 0o600 }); }
  /** True when anything is stored under this id, including a table that failed to load. */
  has(id: string) { return existsSync(this.p(id, 'config.json')) || existsSync(this.p(id, 'ledger.jsonl')); }
  tables(): string[] { return readdirSync(this.dir).filter(f => f.endsWith('.config.json')).map(f => decodeURIComponent(f.slice(0, -'.config.json'.length))); }
}
