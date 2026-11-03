import { describe, it, expect } from 'vitest';
import { Table } from '../src/table.js';
import { cfg, seat, owners, boardCard } from './helpers.js';
import { check } from '../src/schema.js';

const codeOf = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { code: string }).code; } return 'OK'; };

describe('handshake', () => {
  it('verifies owner signatures, rejects replay, unknown owners and taken seats', () => {
    const t = new Table(cfg('t1', { kind: 'broadcast', order: ['a', 'b'] }));
    const req = owners.tao.signJoin('t1', { seat: 'a', kind: 'bot', card: { bot: 'x', capabilities: [] } });
    expect(codeOf(() => t.join({ ...req, signature: owners.jenny.signJoin('t1', { seat: 'a', kind: 'bot', card: { bot: 'x', capabilities: [] } }).signature } as never))).toBe('E_BAD_SIGNATURE');
    t.join(req as never);
    expect(codeOf(() => t.join(req as never))).toBe('E_REPLAY');
    expect(codeOf(() => seat(t, 'a', 'jenny'))).toBe('E_SEAT_TAKEN');
    const forged = owners.tao.signJoin('t1', { seat: 'z', kind: 'bot', card: { bot: 'x', capabilities: [] } });
    expect(codeOf(() => t.join({ ...forged, owner: 'mallory' } as never))).toBe('E_NOT_OWNER');
    // signed for another table
    expect(codeOf(() => t.join(owners.tao.signJoin('other', { seat: 'q', kind: 'bot', card: { bot: 'x', capabilities: [] } }) as never))).toBe('E_BAD_SIGNATURE');
  });

  it('requires an end condition', () => {
    expect(codeOf(() => new Table(cfg('t', { kind: 'broadcast', order: ['a'] }, { termination: { any: [] } })))).toBe('E_SCHEMA');
  });
});

describe('floor control', () => {
  it('broadcast: round robin, only the holder may speak, pass is valid, rounds end the table', () => {
    const t = new Table(cfg('b', { kind: 'broadcast', order: ['a', 'b'], rounds: 2 }));
    seat(t, 'a', 'tao');
    expect(t.holder).toBe(null); // not all seats present yet
    seat(t, 'b', 'jenny');
    expect(t.holder).toBe('a');
    expect(codeOf(() => t.post('b', { kind: 'say', body: 'me first' }))).toBe('E_NOT_FLOOR');
    t.post('a', { kind: 'say', body: 'hi' });
    expect(t.holder).toBe('b');
    t.post('b', { kind: 'pass' });
    t.post('a', { kind: 'say', body: 'round 2' });
    t.post('b', { kind: 'say', body: 'done' });
    expect(t.status).toBe('closed');
    expect(t.closeReason).toBe('rounds_exhausted');
    expect(codeOf(() => t.post('a', { kind: 'say', body: 'late' }))).toBe('E_TABLE_CLOSED');
  });

  it('truncates over-budget messages and enforces the table token budget', () => {
    const t = new Table(cfg('bud', { kind: 'broadcast', order: ['a', 'b'], rounds: 10 }, { floor: { max_chars: 20 }, termination: { any: [{ budget_tokens: 12 }, 'rounds_exhausted'] } }));
    seat(t, 'a', 'tao'); seat(t, 'b', 'jenny');
    const e = t.post('a', { kind: 'say', body: 'x'.repeat(100) });
    expect(e.body).toHaveLength(20);
    expect(e.truncated).toBe(true);
    t.post('b', { kind: 'say', body: 'y'.repeat(20) });
    t.post('a', { kind: 'say', body: 'z'.repeat(20), budget: { tokens_used: 5 } });
    expect(t.status).toBe('closed');
    expect(t.closeReason).toMatch(/budget_exhausted/);
  });

  it('raise_hand queues a seat for the next turn', () => {
    const t = new Table(cfg('rh', { kind: 'broadcast', order: ['a', 'b'], rounds: 3 }));
    seat(t, 'a', 'tao'); seat(t, 'b', 'jenny'); seat(t, 'c', 'ops');
    t.post('c', { kind: 'raise_hand', body: 'I know this' });
    t.post('a', { kind: 'say', body: 'q' });
    expect(t.holder).toBe('c');
    t.post('c', { kind: 'say', body: 'answer' });
    expect(t.holder).toBe('b'); // the queue does not consume the fixed sequence
  });

  it('bot-to-bot depth limit hands the floor to a human, whose message resets the counter', () => {
    const t = new Table(cfg('d', { kind: 'broadcast', order: ['a', 'b'], rounds: 50 }, { floor: { max_bot_depth: 3 } }));
    seat(t, 'a', 'tao'); seat(t, 'b', 'jenny'); seat(t, 'h', 'tao', undefined, 'human');
    t.post('a', { kind: 'say', body: '1' }); t.post('b', { kind: 'say', body: '2' }); t.post('a', { kind: 'say', body: '3' });
    expect(t.holder).toBe('h');
    t.post('h', { kind: 'say', body: 'ok bots, one more each' });
    expect(t.botDepth).toBe(0);
    expect(t.holder).toBe('b');
  });

  it('without a human, the depth limit stops the table', () => {
    const t = new Table(cfg('d2', { kind: 'broadcast', order: ['a', 'b'], rounds: 50 }, { floor: { max_bot_depth: 2 } }));
    seat(t, 'a', 'tao'); seat(t, 'b', 'jenny');
    t.post('a', { kind: 'say', body: '1' }); t.post('b', { kind: 'say', body: '2' });
    expect(t.status).toBe('closed');
    expect(t.closeReason).toMatch(/depth_exhausted/);
  });
});

describe('topologies', () => {
  it('debate: pro/con alternate, judge sees only their says, only the judge decides, decision ends', () => {
    const t = new Table(cfg('deb', { kind: 'debate', pro: 'p', con: 'c', judge: 'j', rounds: 2 }));
    seat(t, 'p', 'tao'); seat(t, 'c', 'jenny'); seat(t, 'j', 'ops');
    t.post('p', { kind: 'say', body: 'pro1' });
    t.post('c', { kind: 'pass', body: 'skip' });
    t.post('p', { kind: 'say', body: 'pro2' });
    expect(codeOf(() => t.post('c', { kind: 'decision', body: 'I win' }))).toBe('E_NOT_DECIDER');
    t.post('c', { kind: 'say', body: 'con2' });
    expect(t.holder).toBe('j');
    const jp = t.projection('j', 0);
    expect(jp.tail.filter(e => e.kind === 'pass')).toHaveLength(0);
    expect(jp.tail.filter(e => e.kind === 'say').map(e => e.body)).toEqual(['pro1', 'pro2', 'con2']);
    t.post('j', { kind: 'decision', body: 'pro wins' });
    expect(t.status).toBe('closed');
    expect(t.memory().decisions[0].body).toBe('pro wins');
  });

  it('pipeline: each stage sees only its predecessor', () => {
    const t = new Table(cfg('pipe', { kind: 'pipeline', stages: ['s1', 's2', 's3'] }));
    seat(t, 's1', 'tao'); seat(t, 's2', 'jenny'); seat(t, 's3', 'ops');
    t.post('s1', { kind: 'say', body: 'draft' });
    t.post('s2', { kind: 'say', body: 'reviewed' });
    const p3 = t.projection('s3', 0);
    expect(p3.tail.filter(e => e.kind === 'say').map(e => e.body)).toEqual(['reviewed']);
    t.post('s3', { kind: 'decision', body: 'ship' });
    expect(t.status).toBe('closed');
  });

  it('hub_spoke: the hub hands the floor by @address and gets it back; spokes do not see each other', () => {
    const t = new Table(cfg('hub', { kind: 'hub_spoke', hub: 'm', order: ['x', 'y'], rounds: 3 }));
    seat(t, 'm', 'tao'); seat(t, 'x', 'jenny'); seat(t, 'y', 'ops');
    expect(t.holder).toBe('m');
    t.post('m', { kind: 'say', body: 'x, your view?', to: ['@x'] });
    expect(t.holder).toBe('x');
    t.post('x', { kind: 'say', body: 'x view' });
    expect(t.holder).toBe('m');
    t.post('m', { kind: 'say', body: 'y?', to: ['@y'] });
    const py = t.projection('y', 0);
    expect(py.tail.some(e => e.body === 'x view')).toBe(false);
    expect(t.projection('m', 0).tail.some(e => e.body === 'x view')).toBe(true);
    t.post('y', { kind: 'say', body: 'y view' });
    t.post('m', { kind: 'decision', body: 'done' });
    expect(t.status).toBe('closed');
  });

  it('delegation: a manager may delegate only to its own reports; floor walks back up the tree', () => {
    const t = new Table(cfg('tree', { kind: 'delegation', hub: 'lead', reports: { lead: ['a'], a: ['a1'] }, rounds: 3 }));
    seat(t, 'lead', 'tao'); seat(t, 'a', 'jenny'); seat(t, 'a1', 'jenny');
    t.post('lead', { kind: 'say', body: 'a1, go', to: ['@a1'] }); // not a direct report: floor stays with lead
    expect(t.holder).toBe('lead');
    t.post('lead', { kind: 'say', body: 'a, own this', to: ['@a'] });
    t.post('a', { kind: 'say', body: 'a1 do the test', to: ['@a1'] });
    expect(t.holder).toBe('a1');
    t.post('a1', { kind: 'say', body: 'done' });
    expect(t.holder).toBe('a');
    t.post('a', { kind: 'say', body: 'summary for lead' });
    expect(t.holder).toBe('lead');
  });

  it('per-seat visibility override uses <seat>.<kind> patterns', () => {
    const t = new Table(cfg('vis', { kind: 'broadcast', order: ['a', 'b', 'c'] }, { visibility: { c: ['a.say'] } }));
    seat(t, 'a', 'tao'); seat(t, 'b', 'jenny'); seat(t, 'c', 'ops');
    t.post('a', { kind: 'say', body: 'A' }); t.post('b', { kind: 'say', body: 'B' });
    expect(t.projection('c', 0).tail.filter(e => e.kind === 'say').map(e => e.body)).toEqual(['A']);
  });
});

describe('propose -> approve -> execute -> verify', () => {
  function setup(extra = {}) {
    const t = new Table(cfg('tk', { kind: 'broadcast', order: ['p', 'q'], rounds: 3 }, { watchdog: { heartbeat_ms: 1000 }, ...extra }));
    seat(t, 'p', 'tao', boardCard); seat(t, 'q', 'jenny', boardCard); seat(t, 'chk', 'ops');
    return t;
  }

  it('cross-owner effects wait for the affected owner; executor is the owner\'s bot; verify must be independent', () => {
    const t = setup();
    const pr = t.post('p', { kind: 'proposal', body: 'move #461 up', effects: [{ owner: 'jenny', resource: 'taskboard', action: 'reorder', args: { first: '#461' } }] });
    const id = `task-${pr.seq}`;
    expect(t.task(id).state).toBe('awaiting_approval');
    expect(codeOf(() => t.post('q', { kind: 'receipt', task: id, body: 'eager' }))).toBe('E_NOT_OWNER');
    expect(codeOf(() => t.ownerDecision(owners.tao.signDecision('tk', id, 'approve') as never))).toBe('E_NOT_OWNER');
    const forged = owners.tao.signDecision('tk', id, 'approve');
    expect(codeOf(() => t.ownerDecision({ ...forged, owner: 'jenny' } as never))).toBe('E_BAD_SIGNATURE');
    t.ownerDecision(owners.jenny.signDecision('tk', id, 'approve', 'fine') as never);
    expect(t.task(id)).toMatchObject({ state: 'approved', executor: 'q' });
    t.post('q', { kind: 'status', task: id, state: 'running' });
    t.post('q', { kind: 'receipt', task: id, body: 'reordered', artifact: { first: '#461' } });
    expect(codeOf(() => t.post('q', { kind: 'verify', task: id, result: 'pass' }))).toBe('E_SELF_VERIFY');
    t.post('chk', { kind: 'verify', task: id, result: 'pass', body: 'artifact first == #461' });
    expect(t.task(id).state).toBe('verified');
  });

  it('own-owner actions and auto_approve in the owner-signed card skip approval; rejections stop the task', () => {
    const t = setup();
    const own = t.post('p', { kind: 'proposal', body: 'my board', effects: [{ owner: 'tao', resource: 'taskboard', action: 'reorder' }] });
    expect(t.task(`task-${own.seq}`)).toMatchObject({ state: 'approved', executor: 'p' });
    const x = t.post('p', { kind: 'proposal', body: 'theirs', effects: [{ owner: 'jenny', resource: 'taskboard', action: 'reorder' }] });
    t.ownerDecision(owners.jenny.signDecision('tk', `task-${x.seq}`, 'reject', 'not this week') as never);
    expect(t.task(`task-${x.seq}`).state).toBe('rejected');

    // jenny's own signed card accepts reorders from any seat
    const t2 = new Table(cfg('tk2', { kind: 'broadcast', order: ['p', 'q'], rounds: 3 }));
    seat(t2, 'p', 'tao', boardCard);
    seat(t2, 'q', 'jenny', { bot: 'test-bot', capabilities: [{ resource: 'taskboard', actions: ['reorder'], auto_approve: true }] });
    const a = t2.post('p', { kind: 'proposal', body: 'auto', effects: [{ owner: 'jenny', resource: 'taskboard', action: 'reorder' }] });
    expect(t2.task(`task-${a.seq}`).state).toBe('approved');

    // requires_approval on the same capability wins over auto_approve
    const t3 = new Table(cfg('tk3', { kind: 'broadcast', order: ['p', 'q'], rounds: 3 }));
    seat(t3, 'p', 'tao', boardCard);
    seat(t3, 'q', 'jenny', { bot: 'test-bot', capabilities: [{ resource: 'taskboard', actions: ['reorder'], auto_approve: true, requires_approval: true }] });
    const b = t3.post('p', { kind: 'proposal', body: 'flagged', effects: [{ owner: 'jenny', resource: 'taskboard', action: 'reorder' }] });
    expect(t3.task(`task-${b.seq}`).state).toBe('awaiting_approval');
  });

  it('the table config cannot grant auto-approval on an owner\'s behalf', () => {
    // The table creator writes the config but does not hold jenny's key.
    const forged = Object.fromEntries(Object.values(owners).map(o => [o.id, {
      public_key: o.publicKey, ...(o.id === 'jenny' ? { auto_approve: [{ resource: 'taskboard', action: 'reorder' }] } : {}),
    }]));
    expect(codeOf(() => new Table(cfg('forged', { kind: 'broadcast', order: ['p', 'q'] }, { owners: forged as never })))).toBe('E_SCHEMA');
  });

  it('rejects effects with no capable executor or mixed owners', () => {
    const t = setup();
    expect(codeOf(() => t.post('p', { kind: 'proposal', body: 'x', effects: [{ owner: 'jenny', resource: 'calendar', action: 'move' }] }))).toBe('E_NO_EXECUTOR');
    expect(codeOf(() => t.post('p', { kind: 'proposal', body: 'x', effects: [{ owner: 'jenny', resource: 'taskboard', action: 'reorder' }, { owner: 'tao', resource: 'taskboard', action: 'reorder' }] }))).toBe('E_MIXED_OWNERS');
  });

  it('watchdog marks silent tasks stalled; the executor can resume', () => {
    let now = 1_000_000;
    const t = new Table(cfg('wd', { kind: 'broadcast', order: ['p', 'q'] }, { watchdog: { heartbeat_ms: 100 } }), undefined, undefined, () => now);
    seat(t, 'p', 'tao', boardCard); seat(t, 'q', 'jenny', boardCard);
    const pr = t.post('p', { kind: 'proposal', body: 'x', effects: [{ owner: 'jenny', resource: 'taskboard', action: 'reorder' }] });
    const id = `task-${pr.seq}`;
    t.ownerDecision(owners.jenny.signDecision('wd', id, 'approve') as never);
    now += 500; t.tick();
    expect(t.task(id).state).toBe('stalled');
    t.post('q', { kind: 'status', task: id, state: 'running' });
    expect(t.task(id).state).toBe('running');
  });
});

describe('projection', () => {
  it('stable prefix hash, append-only tail since cursor, no timestamps, long bodies by reference', () => {
    const t = new Table(cfg('pj', { kind: 'broadcast', order: ['a', 'b'], rounds: 5 }, { projection: { inline_limit: 64 } }));
    seat(t, 'a', 'tao'); seat(t, 'b', 'jenny');
    const p1 = t.projection('a');
    t.post('a', { kind: 'say', body: 'short' });
    t.post('b', { kind: 'say', body: 'L'.repeat(300) });
    const p2 = t.projection('a');
    expect(p2.prefix_hash).toBe(p1.prefix_hash);
    expect(p2.tail[0].seq).toBe(p1.cursor + 1);
    expect(p2.tail.every(e => !('ts' in e))).toBe(true);
    const long = p2.tail.find(e => e.seat === 'b' && e.kind === 'say')!;
    expect(long.body!.length).toBeLessThan(80);
    expect(long.refs).toContain(`entry:${long.seq}`);
    expect(t.expand('a', long.seq).body).toHaveLength(300);
    for (const e of t.entries) check('ledger-entry', e);
    check('projection', p2);
  });
});
