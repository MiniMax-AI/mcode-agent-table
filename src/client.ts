// @byob/seat — client SDK for sitting at a BYOB table over HTTP + SSE.
import { PROTOCOL, ByobError, type CapabilityCard, type Entry, type PostRequest, type Projection, type Task, type Effect, type ErrorCode } from './protocol.js';
import { generateOwnerKeys, nonce, signPayload, type OwnerKeys } from './crypto.js';

/** An owner holds the private key. It signs seat joins and approvals; bots never hold other owners' keys. */
export class Owner {
  constructor(readonly id: string, readonly keys: OwnerKeys = generateOwnerKeys()) {}
  get publicKey() { return this.keys.publicKey; }
  signJoin(table: string, j: { seat: string; kind: 'bot' | 'human'; role?: string; card: CapabilityCard }) {
    const n = nonce();
    const signature = signPayload(this.keys.privateKey, { table, seat: j.seat, owner: this.id, kind: j.kind, role: j.role, card: j.card, nonce: n });
    return { protocol: PROTOCOL, seat: j.seat, owner: this.id, kind: j.kind, role: j.role, card: j.card, nonce: n, signature };
  }
  signDecision(table: string, task: string, decision: 'approve' | 'reject', reason?: string) {
    const n = nonce();
    return { owner: this.id, task, decision, reason, nonce: n, signature: signPayload(this.keys.privateKey, { table, owner: this.id, task, decision, reason, nonce: n }) };
  }
  async decide(baseUrl: string, table: string, task: string, decision: 'approve' | 'reject', reason?: string): Promise<Entry> {
    return call(baseUrl, `/v0.1/tables/${enc(table)}/approvals`, 'POST', undefined, this.signDecision(table, task, decision, reason));
  }
}

const enc = encodeURIComponent;

async function call<T>(base: string, path: string, method: string, token?: string, body?: unknown): Promise<T> {
  const r = await fetch(base.replace(/\/$/, '') + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = (await r.json()) as { error?: { code: ErrorCode; message: string } };
  if (!r.ok) throw new ByobError(j.error?.code ?? 'E_INTERNAL', j.error?.message?.replace(/^E_\w+: /, '') ?? r.statusText);
  return j as T;
}

export interface Disclosure { deny?: RegExp[] }

export async function createTable(baseUrl: string, cfg: unknown): Promise<{ table: string; admin_token: string }> {
  return call(baseUrl, '/v0.1/tables', 'POST', undefined, cfg);
}

export class SeatClient {
  constructor(readonly baseUrl: string, readonly table: string, readonly seat: string, readonly token: string, readonly disclosure: Disclosure = {}) {}

  static async join(baseUrl: string, table: string, owner: Owner, j: { seat: string; kind?: 'bot' | 'human'; role?: string; card: CapabilityCard; disclosure?: Disclosure }) {
    const req = owner.signJoin(table, { seat: j.seat, kind: j.kind ?? 'bot', role: j.role, card: j.card });
    const r = await call<{ seat_token: string }>(baseUrl, `/v0.1/tables/${enc(table)}/seats`, 'POST', undefined, req);
    return new SeatClient(baseUrl, table, j.seat, r.seat_token, j.disclosure);
  }

  private path(p: string) { return `/v0.1/tables/${enc(this.table)}/${p}`; }

  /** Disclosure rules run on the bot's side, before anything reaches the table. */
  private guard(req: PostRequest) {
    const text = [req.body ?? '', JSON.stringify(req.effects ?? []), JSON.stringify(req.artifact ?? '')].join('\n');
    const i = (this.disclosure.deny ?? []).findIndex(re => re.test(text));
    // Name the rule by position only: its pattern is itself the private detail it protects.
    if (i >= 0) throw new ByobError('E_DISCLOSURE', `blocked by owner disclosure rule #${i + 1}`);
  }

  async post(req: PostRequest): Promise<Entry> { this.guard(req); return call(this.baseUrl, this.path('entries'), 'POST', this.token, req); }
  say(body: string, extra: Partial<PostRequest> = {}) { return this.post({ kind: 'say', body, ...extra }); }
  pass(body?: string) { return this.post({ kind: 'pass', body }); }
  raiseHand(body?: string) { return this.post({ kind: 'raise_hand', body }); }
  propose(body: string, effects: Effect[], extra: Partial<PostRequest> = {}) { return this.post({ kind: 'proposal', body, effects, ...extra }); }
  decide(body: string, effects?: Effect[]) { return this.post({ kind: 'decision', body, effects }); }
  status(task: string, state: 'running' | 'failed', body?: string) { return this.post({ kind: 'status', task, state, body }); }
  receipt(task: string, body: string, artifact?: unknown) { return this.post({ kind: 'receipt', task, body, artifact }); }
  verify(task: string, result: 'pass' | 'fail', body?: string) { return this.post({ kind: 'verify', task, result, body }); }
  projection(since?: number): Promise<Projection> { return call(this.baseUrl, this.path('projection' + (since === undefined ? '' : `?since=${since}`)), 'GET', this.token); }
  expand(seq: number): Promise<Entry> { return call(this.baseUrl, this.path(`entries/${seq}`), 'GET', this.token); }
  memory(): Promise<{ decisions: unknown[]; tasks: { id: string; state: string }[]; status: string }> { return call(this.baseUrl, this.path('memory'), 'GET', this.token); }
  task(id: string): Promise<Task> { return call(this.baseUrl, this.path(`tasks/${enc(id)}`), 'GET', this.token); }

  /** SSE wake-ups. Yields lightweight notifications; read the projection for content. */
  async *events(signal?: AbortSignal): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
    const r = await fetch(this.baseUrl.replace(/\/$/, '') + this.path('events'), { headers: { authorization: `Bearer ${this.token}` }, signal });
    if (!r.ok || !r.body) throw new ByobError('E_UNAUTHORIZED', `events: HTTP ${r.status}`);
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev && data) yield { event: ev, data: JSON.parse(data) };
      }
    }
  }
}

/** Render a projection as text for a model. The prefix renders identically while it is unchanged (cache-friendly). */
export function renderPrefix(p: Projection): string {
  const seats = (p.prefix.seats as { seat: string; owner: string; kind: string; role?: string; bot: string; proxy: boolean; capabilities: { resource: string; actions: string[] }[] }[])
    .map(s => `- @${s.seat} (owner: ${s.owner}, ${s.kind}${s.role ? ', role: ' + s.role : ''}, bot: ${s.bot}${s.proxy ? ', PROXY' : ''}) can: ${s.capabilities.map(c => `${c.resource}[${c.actions.join('|')}]`).join(', ') || 'talk only'}`)
    .join('\n');
  const decisions = p.prefix.decisions.map(d => `- #${d.seq} @${d.seat}: ${d.body}`).join('\n') || '- (none yet)';
  return [
    `# BYOB table ${p.table} (${PROTOCOL})`,
    `Topic: ${p.prefix.topic}`,
    `Rules: ${JSON.stringify(p.prefix.rules)}`,
    `Seats:\n${seats}`,
    `Decisions in force:\n${decisions}`,
    `You are seat @${p.seat}.`,
  ].join('\n\n');
}

export function renderEntry(e: Entry): string {
  const head = `[#${e.seq}] ${e.seat} ${e.kind}${e.event ? '/' + e.event : ''}${e.to?.length ? ' to ' + e.to.join(',') : ''}${e.reply_to ? ' re #' + e.reply_to : ''}${e.task ? ' ' + e.task : ''}${e.state ? ' state=' + e.state : ''}${e.result ? ' result=' + e.result : ''}`;
  const extra = e.effects?.length ? `\n  effects: ${JSON.stringify(e.effects)}` : '';
  return `${head}${e.body ? ': ' + e.body : ''}${extra}${e.truncated ? ' [truncated by Table Core]' : ''}`;
}

export const renderTail = (p: Projection) => p.tail.map(renderEntry).join('\n') || '(no new entries)';

// ---------------------------------------------------------------------------------------------
// Seat runner: turns any "brain" (a model-backed agent, a script) into a protocol-correct seat.

export type FloorAction =
  | { kind: 'say'; body: string; to?: string[]; tokens_used?: number }
  | { kind: 'pass'; body?: string }
  | { kind: 'proposal'; body: string; effects: Effect[]; then?: { kind: 'say' | 'pass'; body?: string }; tokens_used?: number }
  | { kind: 'decision'; body: string; effects?: Effect[]; tokens_used?: number };

export interface Brain {
  /** Called when this seat holds the floor. Gets the new tail since its last turn and the stable prefix. */
  onFloor(p: Projection, ctx: { first: boolean; prefixChanged: boolean }): Promise<FloorAction>;
  /** Called when an approved task is assigned to this seat (it is the affected owner's bot). */
  onTask?(t: Task, p: Projection): Promise<{ ok: boolean; body: string; artifact?: unknown }>;
  /** Called when some task reached `reported`; return a verdict to act as an independent verifier. */
  onReported?(t: Task, receipt: Entry, p: Projection): Promise<{ result: 'pass' | 'fail'; body: string } | null>;
}

export async function runSeat(c: SeatClient, brain: Brain, opts: { signal?: AbortSignal; pollMs?: number; log?: (s: string) => void; stayForTasks?: boolean } = {}) {
  const log = opts.log ?? (() => {});
  let cursor = 0;
  let lastGrant: number | null = null;
  let lastPrefix = '';
  let first = true;
  const doneTasks = new Set<string>();
  const verified = new Set<string>();
  const w: { wake: (() => void) | null } = { wake: null };
  const ac = new AbortController();
  opts.signal?.addEventListener('abort', () => ac.abort());
  (async () => { try { for await (const _ of c.events(ac.signal)) w.wake?.(); } catch { /* aborted */ } })();
  const sleep = () => new Promise<void>(r => { const t = setTimeout(r, opts.pollMs ?? 1500); w.wake = () => { clearTimeout(t); r(); }; });

  try {
    while (!ac.signal.aborted) {
      const p = await c.projection(cursor);
      // Ask again from the same cursor next time unless we acted; the tail is append-only.
      if (p.floor.you_have_floor && p.floor.grant_seq !== lastGrant && p.status === 'open') {
        lastGrant = p.floor.grant_seq;
        const prefixChanged = p.prefix_hash !== lastPrefix;
        lastPrefix = p.prefix_hash;
        let a: FloorAction;
        try { a = await brain.onFloor(p, { first, prefixChanged }); } catch (err) {
          // A brain failure must not wedge the table: report it and yield the floor.
          log(`${c.seat} brain error: ${(err as Error).message}`);
          a = { kind: 'pass', body: `(seat error: ${String((err as Error).message).slice(0, 200)})` };
        }
        first = false;
        cursor = p.cursor;
        try {
          await act(c, a);
          log(`${c.seat} ${a.kind}`);
        } catch (err) {
          log(`${c.seat} action rejected: ${(err as Error).message}; passing`);
          // A withheld post must not reach the table, not even through the error text.
          const body = (err as ByobError).code === 'E_DISCLOSURE'
            ? `(my ${a.kind} was withheld by my owner's disclosure rules)`
            : `(my ${a.kind} was rejected: ${(err as Error).message.slice(0, 200)})`;
          // If even that pass is refused, pass without a body so the seat never keeps the floor.
          await c.pass(body).catch(() => c.pass()).catch(e => log(`${c.seat} could not yield the floor: ${(e as Error).message}`));
        }
        continue;
      }
      for (const t of p.my_tasks) {
        if (t.executor === c.seat && t.state === 'approved' && !doneTasks.has(t.id) && brain.onTask) {
          doneTasks.add(t.id);
          await c.status(t.id, 'running', 'started in my owner\'s workspace');
          log(`${c.seat} executing ${t.id}`);
          const r = await brain.onTask(t, p).catch(err => ({ ok: false, body: String(err) }));
          if (r.ok) await c.receipt(t.id, r.body, (r as { artifact?: unknown }).artifact);
          else await c.status(t.id, 'failed', r.body.slice(0, 2000));
        }
      }
      if (brain.onReported) {
        const mem = await c.memory();
        for (const mt of mem.tasks.filter(t => t.state === 'reported' && !verified.has(t.id))) {
          const t = await c.task(mt.id);
          if (t.executor === c.seat || !t.receipt_seq) continue;
          verified.add(t.id);
          const v = await brain.onReported(t, await c.expand(t.receipt_seq), p);
          if (v) await c.verify(t.id, v.result, v.body);
        }
      }
      if (p.status === 'closed') {
        const mem = await c.memory();
        const open = mem.tasks.some(t => ['awaiting_approval', 'approved', 'running', 'reported'].includes(t.state));
        if (!open || !(opts.stayForTasks ?? true)) break;
      }
      await sleep();
    }
  } finally { ac.abort(); }
}

async function act(c: SeatClient, a: FloorAction) {
  switch (a.kind) {
    case 'say': return c.say(a.body, { to: a.to, budget: a.tokens_used ? { tokens_used: a.tokens_used } : undefined });
    case 'pass': return c.pass(a.body);
    case 'decision': return c.post({ kind: 'decision', body: a.body, effects: a.effects, budget: a.tokens_used ? { tokens_used: a.tokens_used } : undefined });
    case 'proposal': {
      await c.propose(a.body, a.effects, { budget: a.tokens_used ? { tokens_used: a.tokens_used } : undefined });
      const then = a.then ?? { kind: 'pass' as const, body: 'proposal filed' };
      return then.kind === 'say' ? c.say(then.body ?? '') : c.pass(then.body);
    }
  }
}
