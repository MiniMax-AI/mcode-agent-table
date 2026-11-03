// Table Core: the single writer of a table's append-only ledger.
// Every state change is an Entry; `apply()` is the only mutator, so replaying the ledger
// reproduces the table exactly (floor, seats, tasks, budget, status).
import { EventEmitter } from 'node:events';
import {
  PROTOCOL, ByobError, estimateTokens,
  type Entry, type TableConfig, type Seat, type Task, type JoinRequest, type PostRequest,
  type OwnerDecision, type Projection, type Effect,
} from './protocol.js';
import { makePolicy, matchVisibility, type Policy, type PolicyState } from './policy.js';
import { canonical, sha256, verifyPayload } from './crypto.js';
import { check } from './schema.js';

export interface Store {
  append(e: Entry): void;
}

const GOVERNANCE = new Set(['system', 'proposal', 'decision', 'approval', 'rejection', 'status', 'receipt', 'verify']);

export class Table extends EventEmitter {
  readonly cfg: TableConfig;
  readonly policy: Policy;
  entries: Entry[] = [];
  seats = new Map<string, Seat>();
  tasks = new Map<string, Task>();
  holder: string | null = null;
  grantSeq: number | null = null;
  pstate: PolicyState;
  status: 'open' | 'closed' = 'open';
  closeReason?: string;
  tokens = 0;
  botDepth = 0;
  usedNonces = new Set<string>();
  cursors = new Map<string, number>();
  private savedHolder: string | null = null;

  constructor(cfg: TableConfig, private store?: Store, replay?: Entry[], private now: () => number = Date.now) {
    super();
    check('table-config', cfg);
    if (!cfg.termination?.any?.length) throw new ByobError('E_NO_TERMINATION', 'a table needs at least one end condition');
    this.cfg = cfg;
    this.policy = makePolicy(cfg);
    this.pstate = this.policy.init();
    if (replay?.length) for (const e of replay) this.apply(e);
    else this.write({ seat: 'core', kind: 'system', event: 'table_opened', body: cfg.topic, data: { topology: cfg.topology.kind } });
  }

  get maxChars() { return this.cfg.floor?.max_chars ?? 4000; }
  get maxBotDepth() { return this.cfg.floor?.max_bot_depth ?? 32; }
  get deciders() { return this.cfg.floor?.decision_by ?? this.policy.deciders(); }

  // ---------- the single writer ----------
  private write(partial: Omit<Entry, 'seq' | 'table'>): Entry {
    const e = { seq: this.entries.length + 1, table: this.cfg.id, ...partial, ts: new Date(this.now()).toISOString() } as Entry;
    this.store?.append(e);
    this.apply(e);
    this.emit('entry', e);
    return e;
  }

  private apply(e: Entry) {
    this.entries.push(e);
    const d = e.data ?? {};
    if (typeof d.nonce === 'string') this.usedNonces.add(d.nonce);
    switch (e.kind) {
      case 'system':
        if (e.event === 'seat_joined') this.seats.set(d.seat as string, { ...(d as unknown as Seat), joined_seq: e.seq });
        if (e.event === 'floor_granted') {
          this.holder = (d.holder as string) ?? null; this.grantSeq = e.seq; this.pstate = d.policy as PolicyState;
          if (d.depth_reset) this.botDepth = 0;
          this.savedHolder = (d.resume as string) ?? null;
        }
        if (e.event === 'table_closed') { this.status = 'closed'; this.holder = null; this.closeReason = d.reason as string; }
        if (e.event === 'task_opened' || e.event === 'task_state') {
          const id = e.task!;
          const prev = this.tasks.get(id);
          const t: Task = prev ?? {
            id, opened_seq: e.seq, proposer: d.proposer as string, owner: d.owner as string,
            effects: d.effects as Effect[], state: 'awaiting_approval', executor: null, last_progress_ms: 0,
          };
          t.state = d.state as Task['state'];
          if (d.executor !== undefined) t.executor = d.executor as string | null;
          if (d.receipt_seq) t.receipt_seq = d.receipt_seq as number;
          t.last_progress_ms = Date.parse(e.ts ?? '') || 0;
          this.tasks.set(id, t);
        }
        break;
      case 'raise_hand':
        if (this.status === 'open') this.pstate = this.policy.raiseHand(this.pstate, e.seat);
        break;
      case 'say': case 'proposal': case 'decision':
        this.tokens += e.budget?.tokens_used ?? estimateTokens(e.body);
        if (e.kind === 'say') {
          const s = this.seats.get(e.seat);
          this.botDepth = s?.kind === 'human' ? 0 : this.botDepth + 1;
        }
        break;
    }
  }

  // ---------- joining ----------
  join(req: JoinRequest): Seat {
    check('join-request', req);
    if (req.protocol !== PROTOCOL) throw new ByobError('E_PROTOCOL', `unsupported protocol ${req.protocol}`);
    const owner = this.cfg.owners[req.owner];
    if (!owner) throw new ByobError('E_NOT_OWNER', `owner ${req.owner} is not registered on table ${this.cfg.id}`);
    if (this.usedNonces.has(req.nonce)) throw new ByobError('E_REPLAY', 'nonce already used');
    const { signature, ...rest } = req;
    const payload = { table: this.cfg.id, seat: rest.seat, owner: rest.owner, kind: rest.kind, role: rest.role, card: rest.card, nonce: rest.nonce };
    if (!verifyPayload(owner.public_key, payload, signature)) throw new ByobError('E_BAD_SIGNATURE', 'join signature does not verify against the owner key');
    if (this.seats.has(req.seat)) throw new ByobError('E_SEAT_TAKEN', `seat ${req.seat} already joined`);
    if (this.status === 'closed') throw new ByobError('E_TABLE_CLOSED', 'table is closed');
    this.write({
      seat: 'core', kind: 'system', event: 'seat_joined',
      body: `${req.seat} joined for ${req.owner}${req.card.proxy ? ' (PROXY seat)' : ''}`,
      data: { seat: req.seat, owner: req.owner, kind: req.kind, role: req.role, transport: req.transport ?? 'http', card: req.card, nonce: req.nonce },
    });
    this.maybeStart();
    return this.seats.get(req.seat)!;
  }

  private maybeStart() {
    if (this.grantSeq !== null || this.status !== 'open') return;
    if (this.policy.required().every(s => this.seats.has(s))) this.advance(this.pstate, true);
  }

  /** Grant the floor per policy state `s`, or close the table. */
  private advance(s: PolicyState, initial = false) {
    if (this.checkTermination()) return;
    // Floor control: too many consecutive bot turns -> floor goes to a human, or the table stops.
    if (!initial && this.botDepth >= this.maxBotDepth) {
      const human = [...this.seats.values()].find(x => x.kind === 'human');
      const cur = this.policy.current(s);
      if (human) {
        this.write({ seat: 'core', kind: 'system', event: 'floor_granted', to: ['@' + human.seat], body: `bot depth ${this.botDepth} reached; floor to human ${human.seat}`,
          data: { holder: human.seat, policy: s, resume: 'holder' in cur ? cur.holder : null } });
        return;
      }
      return this.close(`depth_exhausted (${this.botDepth} consecutive bot turns, no human seated)`);
    }
    const n = this.policy.current(s);
    if ('end' in n) {
      if (this.cfg.termination.any.includes('rounds_exhausted')) return this.close('rounds_exhausted');
      return this.close('rounds_exhausted (policy has no more turns)');
    }
    this.write({ seat: 'core', kind: 'system', event: 'floor_granted', to: ['@' + n.holder], body: `floor -> ${n.holder}`,
      data: { holder: n.holder, policy: s, max_chars: this.maxChars } });
  }

  private checkTermination(): boolean {
    for (const c of this.cfg.termination.any) {
      if (typeof c === 'object' && 'budget_tokens' in c && this.tokens > c.budget_tokens) { this.close(`budget_exhausted (${this.tokens} > ${c.budget_tokens} tokens)`); return true; }
      if (typeof c === 'object' && 'max_entries' in c && this.entries.length >= c.max_entries) { this.close(`max_entries (${c.max_entries})`); return true; }
    }
    return false;
  }

  systemNote(body: string, data: Record<string, unknown>, refs?: string[]) {
    return this.write({ seat: 'core', kind: 'system', event: data.decisions ? 'subtable_result' : 'note', body, data, refs });
  }

  close(reason: string) {
    if (this.status === 'closed') return;
    this.write({ seat: 'core', kind: 'system', event: 'table_closed', body: `table closed: ${reason}`, data: { reason } });
  }

  // ---------- posting ----------
  seat(id: string): Seat {
    const s = this.seats.get(id);
    if (!s) throw new ByobError('E_NOT_FOUND', `seat ${id}`);
    return s;
  }

  post(seatId: string, req: PostRequest): Entry {
    check('post-request', req);
    const seat = this.seat(seatId);
    const human = seat.kind === 'human';
    const floorPlane = ['say', 'pass', 'proposal', 'decision'].includes(req.kind);
    if (floorPlane || req.kind === 'raise_hand') {
      if (this.status === 'closed') throw new ByobError('E_TABLE_CLOSED', `table closed (${this.closeReason})`);
    }
    if (floorPlane && !human && this.holder !== seatId) throw new ByobError('E_NOT_FLOOR', `${seatId} does not hold the floor (holder: ${this.holder ?? 'none'}); use raise_hand`);
    if (req.kind === 'decision' && !this.deciders.includes(seatId)) throw new ByobError('E_NOT_DECIDER', `${seatId} may not post decisions (decision_by: ${this.deciders.join(', ') || 'none'})`);
    for (const a of req.to ?? []) if (a.startsWith('@') && !this.seats.has(a.slice(1))) throw new ByobError('E_ADDRESS', `no seat ${a}`);
    if (req.kind === 'say') this.policy.checkAddress?.(this.pstate, seatId, req.to);

    let body = req.body;
    let truncated: boolean | undefined;
    if (body !== undefined && floorPlane && body.length > this.maxChars) { body = body.slice(0, this.maxChars); truncated = true; }

    switch (req.kind) {
      case 'raise_hand': {
        return this.write({ seat: seatId, kind: 'raise_hand', body }); // queued by apply()
      }
      case 'say': case 'pass': {
        const e = this.write({ seat: seatId, kind: req.kind, to: req.to, reply_to: req.reply_to, body, truncated, refs: req.refs, budget: req.budget });
        this.endTurn(seatId, e);
        return e;
      }
      case 'proposal': case 'decision': {
        if (req.kind === 'proposal' && !req.effects?.length) throw new ByobError('E_SCHEMA', 'proposal requires effects; to speak without asking for an action, post kind "say"');
        const plan = req.effects?.length ? this.planTask(seat, req.effects) : null;
        const e = this.write({ seat: seatId, kind: req.kind, to: req.to, reply_to: req.reply_to, body, truncated, effects: req.effects, refs: req.refs, budget: req.budget });
        if (plan) this.openTask(e, seat, plan);
        if (req.kind === 'decision') {
          if (this.cfg.termination.any.includes('decision')) this.close(`decision #${e.seq}`);
          else this.endTurn(seatId, e);
        }
        return e;
      }
      case 'status': case 'receipt': case 'verify':
        return this.workPlane(seat, req);
    }
  }

  private endTurn(seatId: string, e: Entry) {
    if (this.status === 'closed') return;
    if (this.holder === seatId) {
      const resume = this.savedHolder;
      if (this.seats.get(seatId)?.kind === 'human' && resume !== null) {
        // human interjection while holding the floor after a depth stop: resume the policy where it was
        this.write({ seat: 'core', kind: 'system', event: 'floor_granted', to: ['@' + resume], body: `floor -> ${resume} (resumed after human)`, data: { holder: resume, policy: this.pstate, depth_reset: true } });
        return;
      }
      this.advance(this.policy.after(this.pstate, e));
    }
    // A human speaking out of turn does not move the floor; it only resets the bot-depth counter (apply()).
  }

  // ---------- tasks: propose -> approve -> execute -> verify ----------
  private planTask(proposer: Seat, effects: Effect[]) {
    const owner = effects[0].owner;
    if (effects.some(f => f.owner !== owner)) throw new ByobError('E_MIXED_OWNERS', 'v0.1: one proposal may affect only one owner; split it');
    if (!this.cfg.owners[owner]) throw new ByobError('E_NOT_OWNER', `owner ${owner} is not registered`);
    const can = (s: Seat) => effects.every(f => s.card.capabilities.some(c => c.resource === f.resource && c.actions.includes(f.action)));
    const executor = [...this.seats.values()].find(s => s.owner === owner && s.kind === 'bot' && can(s));
    if (!executor) throw new ByobError('E_NO_EXECUTOR', `no seat of owner ${owner} declares ${effects.map(f => f.resource + ':' + f.action).join(', ')}`);
    const flagged = effects.some(f => executor.card.capabilities.some(c => c.resource === f.resource && c.requires_approval));
    // Cross-owner auto-approval comes only from the executor's card, which the affected owner signed at join.
    // The table config is written by the table creator, who does not hold that owner's key.
    const autoRule = effects.every(f => executor.card.capabilities.some(c =>
      c.resource === f.resource && c.actions.includes(f.action) && c.auto_approve === true && !c.requires_approval));
    const auto = autoRule || (proposer.owner === owner && !flagged);
    return { owner, executor: executor.seat, auto, why: autoRule ? 'auto_approve in the owner-signed card' : auto ? 'own-owner action' : null };
  }

  private openTask(e: Entry, proposer: Seat, plan: { owner: string; executor: string; auto: boolean; why: string | null }) {
    const id = `task-${e.seq}`;
    this.write({ seat: 'core', kind: 'system', event: 'task_opened', task: id, reply_to: e.seq, to: plan.auto ? ['@' + plan.executor] : [],
      body: plan.auto ? `${id} auto-approved (${plan.why}); executor ${plan.executor}` : `${id} awaiting approval from owner ${plan.owner}`,
      data: { proposer: proposer.seat, owner: plan.owner, effects: e.effects, state: plan.auto ? 'approved' : 'awaiting_approval', executor: plan.auto ? plan.executor : null, planned_executor: plan.executor } });
  }

  task(id: string): Task {
    const t = this.tasks.get(id);
    if (!t) throw new ByobError('E_NOT_FOUND', `task ${id}`);
    return t;
  }

  ownerDecision(req: OwnerDecision): Entry {
    check('owner-decision', req);
    const t = this.task(req.task);
    if (req.owner !== t.owner) throw new ByobError('E_NOT_OWNER', `${req.task} affects owner ${t.owner}, not ${req.owner}`);
    if (this.usedNonces.has(req.nonce)) throw new ByobError('E_REPLAY', 'nonce already used');
    const payload = { table: this.cfg.id, owner: req.owner, task: req.task, decision: req.decision, reason: req.reason, nonce: req.nonce };
    if (!verifyPayload(this.cfg.owners[req.owner].public_key, payload, req.signature)) throw new ByobError('E_BAD_SIGNATURE', 'owner signature does not verify');
    if (t.state !== 'awaiting_approval') throw new ByobError('E_TASK_STATE', `${t.id} is ${t.state}`);
    const approve = req.decision === 'approve';
    const e = this.write({ seat: 'owner:' + req.owner, kind: approve ? 'approval' : 'rejection', task: t.id, reply_to: t.opened_seq, body: req.reason, data: { nonce: req.nonce, signature: req.signature } });
    const planned = (this.entries[t.opened_seq - 1].data?.planned_executor as string) ?? null;
    this.write({ seat: 'core', kind: 'system', event: 'task_state', task: t.id, to: approve && planned ? ['@' + planned] : [],
      body: approve ? `${t.id} approved by ${req.owner}; executor ${planned}` : `${t.id} rejected by ${req.owner}`,
      data: { state: approve ? 'approved' : 'rejected', executor: approve ? planned : null } });
    return e;
  }

  private workPlane(seat: Seat, req: PostRequest): Entry {
    if (!req.task) throw new ByobError('E_SCHEMA', `${req.kind} requires task`);
    const t = this.task(req.task);
    const setState = (state: string, body: string, extra: Record<string, unknown> = {}) =>
      this.write({ seat: 'core', kind: 'system', event: 'task_state', task: t.id, body, data: { state, ...extra } });
    if (req.kind === 'status' || req.kind === 'receipt') {
      if (seat.seat !== t.executor) throw new ByobError('E_NOT_OWNER', `only executor ${t.executor ?? '(none yet)'} may report on ${t.id}`);
      if (!['approved', 'running', 'stalled'].includes(t.state)) throw new ByobError('E_TASK_STATE', `${t.id} is ${t.state}`);
      if (req.kind === 'status') {
        if (!req.state) throw new ByobError('E_SCHEMA', 'status requires state');
        const e = this.write({ seat: seat.seat, kind: 'status', task: t.id, state: req.state, body: req.body });
        setState(req.state, `${t.id} ${req.state}`);
        return e;
      }
      const e = this.write({ seat: seat.seat, kind: 'receipt', task: t.id, reply_to: t.opened_seq, body: req.body, artifact: req.artifact, refs: req.refs });
      setState('reported', `${t.id} reported by ${seat.seat}; needs verify from another seat`, { receipt_seq: e.seq });
      return e;
    }
    // verify
    if (seat.seat === t.executor) throw new ByobError('E_SELF_VERIFY', 'the executor cannot verify its own receipt');
    if (t.state !== 'reported') throw new ByobError('E_TASK_STATE', `${t.id} is ${t.state}; verify needs a receipt first`);
    if (!req.result) throw new ByobError('E_SCHEMA', 'verify requires result');
    const e = this.write({ seat: seat.seat, kind: 'verify', task: t.id, reply_to: t.receipt_seq, result: req.result, body: req.body });
    setState(req.result === 'pass' ? 'verified' : 'failed', `${t.id} ${req.result === 'pass' ? 'verified' : 'failed verification'} by ${seat.seat}`);
    return e;
  }

  /** Watchdog: mark tasks with no progress past heartbeat as stalled. */
  tick() {
    const hb = this.cfg.watchdog?.heartbeat_ms;
    if (!hb) return;
    for (const t of this.tasks.values()) {
      if ((t.state === 'approved' || t.state === 'running') && this.now() - t.last_progress_ms > hb)
        this.write({ seat: 'core', kind: 'system', event: 'task_state', task: t.id, body: `${t.id} stalled (no progress for ${hb}ms)`, data: { state: 'stalled' } });
    }
  }

  // ---------- reading ----------
  canSee(e: Entry, viewer: string): boolean {
    if (e.seat === viewer || GOVERNANCE.has(e.kind)) return true;
    const v = this.seats.get(viewer);
    if (!v) return false;
    const override = this.cfg.visibility?.[viewer];
    if (override) return matchVisibility(override, e);
    return this.policy.visible(e, viewer);
  }

  prefix() {
    const seats = [...this.seats.values()].sort((a, b) => a.joined_seq - b.joined_seq).map(s => ({
      seat: s.seat, owner: s.owner, kind: s.kind, role: s.role, bot: s.card.bot, proxy: s.card.proxy ?? false,
      capabilities: s.card.capabilities,
    }));
    const decisions = this.entries.filter(e => e.kind === 'decision').map(e => ({ seq: e.seq, seat: e.seat, body: e.body }));
    return {
      topic: this.cfg.topic,
      rules: { protocol: PROTOCOL, table: this.cfg.id, parent: this.cfg.parent, topology: this.cfg.topology, floor: { max_chars: this.maxChars, max_bot_depth: this.maxBotDepth, decision_by: this.deciders }, termination: this.cfg.termination },
      seats, decisions,
    };
  }

  projection(viewer: string, since?: number): Projection {
    this.seat(viewer);
    const from = since ?? this.cursors.get(viewer) ?? 0;
    const limit = this.cfg.projection?.inline_limit ?? 2000;
    const tail = this.entries.filter(e => e.seq > from && this.canSee(e, viewer)).map(e => {
      const { ts: _ts, ...rest } = e; // no wall clock in projections: it would break prompt caching
      if (rest.data) { const { signature: _s, nonce: _n, ...d } = rest.data; rest.data = d; }
      if (rest.body && rest.body.length > limit) return { ...rest, body: rest.body.slice(0, limit) + ' …', refs: [...(rest.refs ?? []), `entry:${e.seq}`] };
      return rest;
    });
    const cursor = this.entries.length;
    this.cursors.set(viewer, cursor);
    const prefix = this.prefix();
    return {
      protocol: PROTOCOL, table: this.cfg.id, seat: viewer, prefix, prefix_hash: sha256(canonical(prefix)), tail, cursor,
      floor: { holder: this.holder, you_have_floor: this.holder === viewer, grant_seq: this.grantSeq, max_chars: this.maxChars },
      status: this.status,
      my_tasks: [...this.tasks.values()].filter(t => t.executor === viewer || t.proposer === viewer),
    };
  }

  expand(viewer: string, seq: number): Entry {
    const e = this.entries[seq - 1];
    if (!e || !this.canSee(e, viewer)) throw new ByobError('E_NOT_FOUND', `entry ${seq}`);
    const { ts: _ts, ...rest } = e;
    return rest;
  }

  /** Table memory: what the table itself remembers (never any bot's private memory). */
  memory() {
    return {
      topic: this.cfg.topic,
      decisions: this.entries.filter(e => e.kind === 'decision').map(e => ({ seq: e.seq, seat: e.seat, body: e.body })),
      tasks: [...this.tasks.values()].map(t => ({ id: t.id, owner: t.owner, state: t.state, executor: t.executor, effects: t.effects })),
      status: this.status, close_reason: this.closeReason, tokens: this.tokens,
    };
  }
}
