// TableHost: owns many tables, seat bearer tokens, persistence and sub-tables.
import { Table } from './table.js';
import { JsonlStore } from './store.js';
import { ByobError, type Entry, type JoinRequest, type TableConfig } from './protocol.js';
import { sha256, token } from './crypto.js';

const ADMIN = '__admin__';

export class TableHost {
  tables = new Map<string, Table>();
  private tokens = new Map<string, Record<string, string>>(); // table -> sha256(token) -> seat

  constructor(private store?: JsonlStore, private now: () => number = Date.now) {
    if (store) for (const id of store.tables()) {
      // One unreadable table must not stop the host: skip it and leave a trace.
      try {
        const { cfg, entries, tokens } = store.load(id);
        const t = new Table(cfg, store.ledger(id), entries, now);
        this.wire(t);
        this.tables.set(id, t);
        this.tokens.set(id, tokens);
      } catch (err) {
        console.warn(`byob: skipping table ${id}: ${(err as Error).message}`);
      }
    }
  }

  create(cfg: TableConfig): { table: Table; admin_token: string } {
    if (this.tables.has(cfg.id) || (cfg.id !== undefined && this.store?.has(cfg.id))) throw new ByobError('E_CONFIG', `table ${cfg.id} exists`);
    if (cfg.parent) this.get(cfg.parent);
    // Table validates the config before it writes anything, so a rejected config is never stored.
    const t = new Table(cfg, this.store?.ledger(cfg.id), undefined, this.now);
    this.store?.saveConfig(cfg);
    this.wire(t);
    this.tables.set(cfg.id, t);
    this.tokens.set(cfg.id, {});
    const admin = token();
    this.tokens.get(cfg.id)![sha256(admin)] = ADMIN;
    this.store?.saveTokens(cfg.id, this.tokens.get(cfg.id)!);
    if (cfg.parent) {
      const p = this.get(cfg.parent);
      p.systemNote(`sub-table ${cfg.id} opened: ${cfg.topic}`, { subtable: cfg.id });
    }
    return { table: t, admin_token: admin };
  }

  /** When a sub-table closes, only its decisions flow back to the parent ledger. */
  private wire(t: Table) {
    t.on('entry', (e: Entry) => {
      if (e.event !== 'table_closed' || !t.cfg.parent) return;
      const p = this.tables.get(t.cfg.parent);
      if (!p) return;
      const decisions = t.entries.filter(x => x.kind === 'decision');
      p.systemNote(
        decisions.length ? `sub-table ${t.cfg.id} decided: ${decisions.map(d => d.body).join(' | ')}` : `sub-table ${t.cfg.id} closed without a decision (${t.closeReason})`,
        { subtable: t.cfg.id, decisions: decisions.map(d => ({ seq: d.seq, seat: d.seat, body: d.body })) },
        decisions.map(d => `table:${t.cfg.id}#${d.seq}`),
      );
    });
  }

  get(id: string): Table {
    const t = this.tables.get(id);
    if (!t) throw new ByobError('E_NOT_FOUND', `table ${id}`);
    return t;
  }

  join(id: string, req: JoinRequest) {
    const t = this.get(id);
    const seat = t.join(req);
    const tok = token();
    const m = this.tokens.get(id)!;
    m[sha256(tok)] = seat.seat;
    this.store?.saveTokens(id, m);
    return { seat, seat_token: tok };
  }

  auth(id: string, bearer: string | undefined): string {
    const seat = bearer ? this.tokens.get(id)?.[sha256(bearer)] : undefined;
    if (!seat || seat === ADMIN) throw new ByobError('E_UNAUTHORIZED', 'missing or invalid seat token');
    return seat;
  }

  authAdmin(id: string, bearer: string | undefined) {
    if (!bearer || this.tokens.get(id)?.[sha256(bearer)] !== ADMIN) throw new ByobError('E_UNAUTHORIZED', 'admin token required');
  }
}
