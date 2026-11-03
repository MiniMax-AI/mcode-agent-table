import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { TableHost } from '../src/host.js';
import { JsonlStore } from '../src/store.js';
import { createTableServer } from '../src/server.js';
import { SeatClient, createTable, runSeat } from '../src/client.js';
import { scriptedBrain, checkerBrain } from '../src/adapters/scripted.js';
import { createBridge } from '../src/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { cfg, owners, boardCard, talkCard } from './helpers.js';

const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });

async function start(dir = mkdtempSync(join(tmpdir(), 'byob-'))) {
  const host = new TableHost(new JsonlStore(dir));
  const server = createTableServer(host, { tickMs: 50 });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { host, dir, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Connect an MCP client to a bridge. With `confirm`, the client supports elicitation and answers as the owner would. */
async function connectMcp(bridge: ReturnType<typeof createBridge>, confirm?: boolean) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 'test', version: '0' }, confirm === undefined ? {} : { capabilities: { elicitation: {} } });
  if (confirm !== undefined) c.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { confirm } }));
  await Promise.all([bridge.connect(a), c.connect(b)]);
  return c;
}
const toolText = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { text: string }[])[0].text;

describe('HTTP + SSE transport', () => {
  it('runs a full debate with scripted seats, a cross-owner proposal, approval, execution and verification', async () => {
    const { url, host } = await start();
    await createTable(url, cfg('e2e', { kind: 'debate', pro: 'pro', con: 'con', judge: 'judge', rounds: 1 }, { termination: { any: ['decision', 'rounds_exhausted'] } }));
    const pro = await SeatClient.join(url, 'e2e', owners.tao, { seat: 'pro', card: { bot: 'script', capabilities: [] } });
    const con = await SeatClient.join(url, 'e2e', owners.jenny, { seat: 'con', card: boardCard });
    const judge = await SeatClient.join(url, 'e2e', owners.ops, { seat: 'judge', card: { bot: 'script', capabilities: [] } });
    const checker = await SeatClient.join(url, 'e2e', owners.ops, { seat: 'checker', card: { bot: 'deterministic-check', capabilities: [] } });
    let board = ['#459', '#461'];
    const runs = [
      runSeat(pro, scriptedBrain([{ kind: 'say', body: '#461 first: it blocks the release' }])),
      runSeat(con, scriptedBrain([{ kind: 'say', body: '#459 has a customer date' }], {
        onTask: async t => { board = [t.effects[0].args!.first as string, ...board.filter(x => x !== t.effects[0].args!.first)]; return { ok: true, body: 'reordered', artifact: { taskboard: board } }; },
      })),
      runSeat(judge, scriptedBrain([{ kind: 'decision', body: '#461 goes first', effects: [{ owner: 'jenny', resource: 'taskboard', action: 'reorder', args: { first: '#461' } }] }])),
      runSeat(checker, checkerBrain((_t, r) => ((r.artifact as { taskboard: string[] }).taskboard[0] === '#461' ? { result: 'pass', body: 'top of board is #461' } : { result: 'fail', body: 'wrong order' }))),
    ];
    // Jenny (the owner, not her bot) approves once the task appears.
    const t = host.get('e2e');
    for (let i = 0; i < 100 && ![...t.tasks.values()].some(x => x.state === 'awaiting_approval'); i++) await new Promise(r => setTimeout(r, 20));
    const task = [...t.tasks.values()][0];
    await owners.jenny.decide(url, 'e2e', task.id, 'approve', 'ok, #461 first');
    await Promise.all(runs);
    expect(t.task(task.id).state).toBe('verified');
    expect(board[0]).toBe('#461');
    expect(t.entries.map(e => e.kind)).toContain('receipt');
  }, 20000);

  it('rejects requests without a valid seat token and returns protocol error codes', async () => {
    const { url } = await start();
    await createTable(url, cfg('auth', { kind: 'broadcast', order: ['a'] }));
    const bad = new SeatClient(url, 'auth', 'a', 'nope');
    await expect(bad.say('hi')).rejects.toMatchObject({ code: 'E_UNAUTHORIZED' });
    const a = await SeatClient.join(url, 'auth', owners.tao, { seat: 'a', card: { bot: 'x', capabilities: [] } });
    const b = await SeatClient.join(url, 'auth', owners.jenny, { seat: 'b', card: { bot: 'x', capabilities: [] } });
    await expect(b.say('not my turn')).rejects.toMatchObject({ code: 'E_NOT_FLOOR' });
    await expect(a.post({ kind: 'shout' } as never)).rejects.toMatchObject({ code: 'E_SCHEMA' });
  });

  it('persists the ledger as JSONL and rebuilds identical state on restart', async () => {
    const s1 = await start();
    await createTable(s1.url, cfg('persist', { kind: 'broadcast', order: ['a', 'b'], rounds: 3 }));
    const a = await SeatClient.join(s1.url, 'persist', owners.tao, { seat: 'a', card: { bot: 'x', capabilities: [] } });
    await SeatClient.join(s1.url, 'persist', owners.jenny, { seat: 'b', card: { bot: 'x', capabilities: [] } });
    await a.say('before restart');
    const before = s1.host.get('persist');
    const s2 = await start(s1.dir);
    const after = s2.host.get('persist');
    expect(after.entries).toEqual(before.entries);
    expect(after.holder).toBe('b');
    expect(after.pstate).toEqual(before.pstate);
    const b2 = new SeatClient(s2.url, 'persist', 'b', (await SeatClient.join(s2.url, 'persist', owners.ops, { seat: 'c', card: { bot: 'x', capabilities: [] } })).token);
    await expect(b2.say('c is not b')).rejects.toMatchObject({ code: 'E_NOT_FLOOR' });
  });

  it('SSE delivers only entries the seat may see', async () => {
    const { url } = await start();
    await createTable(url, cfg('sse', { kind: 'hub_spoke', hub: 'm', order: ['x', 'y'], rounds: 2 }));
    const m = await SeatClient.join(url, 'sse', owners.tao, { seat: 'm', card: { bot: 'x', capabilities: [] } });
    const x = await SeatClient.join(url, 'sse', owners.jenny, { seat: 'x', card: { bot: 'x', capabilities: [] } });
    const y = await SeatClient.join(url, 'sse', owners.ops, { seat: 'y', card: { bot: 'x', capabilities: [] } });
    const seen: number[] = [];
    const ac = new AbortController();
    const reader = (async () => { try { for await (const ev of y.events(ac.signal)) if (ev.event === 'entry') seen.push(ev.data.seq as number); } catch { /* aborted */ } })();
    await new Promise(r => setTimeout(r, 50));
    await m.say('x?', { to: ['@x'] });
    const xs = await x.say('private-ish answer to hub');
    await new Promise(r => setTimeout(r, 100));
    ac.abort(); await reader;
    expect(seen).not.toContain(xs.seq);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('sub-tables write only their decision back to the parent', async () => {
    const { url, host } = await start();
    await createTable(url, cfg('main', { kind: 'broadcast', order: ['a', 'b'], rounds: 5 }));
    await createTable(url, { ...cfg('main.api', { kind: 'debate', pro: 'a', con: 'b', judge: 'a', rounds: 1 }), parent: 'main' });
    const a = await SeatClient.join(url, 'main.api', owners.tao, { seat: 'a', card: { bot: 'x', capabilities: [] } });
    const b = await SeatClient.join(url, 'main.api', owners.jenny, { seat: 'b', card: { bot: 'x', capabilities: [] } });
    await a.say('detail 1: use cursor pagination'); await b.say('detail 2: fine');
    await a.decide('API uses cursor pagination');
    const parent = host.get('main');
    const back = parent.entries.find(e => e.event === 'subtable_result')!;
    expect(back.body).toContain('cursor pagination');
    expect(parent.entries.some(e => e.body?.includes('detail 1'))).toBe(false);
  });

  it('client-side disclosure rules block a post before it reaches the table', async () => {
    const { url, host } = await start();
    await createTable(url, cfg('disc', { kind: 'broadcast', order: ['a'] }));
    const a = await SeatClient.join(url, 'disc', owners.tao, { seat: 'a', card: { bot: 'x', capabilities: [] }, disclosure: { deny: [/medical/i] } });
    await expect(a.say('I am out for a medical appointment')).rejects.toMatchObject({ code: 'E_DISCLOSURE', message: expect.not.stringContaining('medical') });
    expect(host.get('disc').entries.some(e => e.body?.includes('medical'))).toBe(false);
  });

  // The rule /dentist/i matched its own pattern in the fallback pass and wedged the floor;
  // /\bdentist\b/i did not, so the fallback pass carried the pattern into the ledger.
  for (const rule of [/dentist/i, /\bdentist\b/i]) {
    it(`runSeat yields the floor without leaking when a disclosure rule blocks a post (${rule})`, async () => {
      const { url, host } = await start();
      await createTable(url, cfg('disc2', { kind: 'broadcast', order: ['a', 'b'], rounds: 1 }));
      const a = await SeatClient.join(url, 'disc2', owners.jenny, { seat: 'a', card: talkCard, disclosure: { deny: [rule] } });
      await SeatClient.join(url, 'disc2', owners.tao, { seat: 'b', card: talkCard });
      const ac = new AbortController();
      const run = runSeat(a, scriptedBrain([{ kind: 'say', body: 'I am out Thursday for a dentist appointment' }]), { signal: ac.signal, pollMs: 20 });
      const t = host.get('disc2');
      for (let i = 0; i < 50 && t.holder === 'a'; i++) await new Promise(r => setTimeout(r, 20));
      ac.abort(); await run;
      expect(t.holder).toBe('b');
      expect(t.entries.some(e => /dentist/i.test(JSON.stringify(e)))).toBe(false);
      expect(t.entries.find(e => e.seat === 'a' && e.kind === 'pass')?.body).toBe("(my say was withheld by my owner's disclosure rules)");
    });
  }
});

describe('TableHost persistence', () => {
  it('stores nothing for a rejected config, so a restart still loads every table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byob-'));
    const host = new TableHost(new JsonlStore(dir));
    host.create(cfg('good', { kind: 'broadcast', order: ['a'] }));
    expect(() => host.create(cfg('bad', { kind: 'debate', pro: 'a' }))).toThrow(/E_CONFIG/); // debate without con
    expect(() => host.create({} as never)).toThrow(/E_SCHEMA/);
    expect(readdirSync(dir).filter(f => !f.startsWith('good.'))).toEqual([]);
    expect(new TableHost(new JsonlStore(dir)).tables.has('good')).toBe(true);
  });

  it('skips a table it cannot load, leaves a trace, and keeps its id reserved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'byob-'));
    new TableHost(new JsonlStore(dir)).create(cfg('good', { kind: 'broadcast', order: ['a'] }));
    writeFileSync(join(dir, 'broken.config.json'), '{ not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const host = new TableHost(new JsonlStore(dir));
      expect(host.tables.has('good')).toBe(true);
      expect(host.tables.has('broken')).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken'));
      expect(() => host.create(cfg('broken', { kind: 'broadcast', order: ['a'] }))).toThrow(/E_CONFIG/);
    } finally { warn.mockRestore(); }
  });
});

describe('MCP bridge', () => {
  it('lets an MCP client join, read, speak, propose and approve', async () => {
    const { url, host } = await start();
    await createTable(url, cfg('mcp', { kind: 'broadcast', order: ['grok', 'mc'], rounds: 2 }));
    const mc = await SeatClient.join(url, 'mcp', owners.jenny, { seat: 'mc', card: boardCard });
    const tao = createBridge({ url, table: 'mcp', owner: owners.tao, card: { bot: 'grok-bot', capabilities: [] } });
    const jennyBridge = createBridge({ url, table: 'mcp', owner: owners.jenny, seat: mc });
    const c = await connectMcp(tao, true);
    const tools = (await c.listTools()).tools.map(t => t.name);
    expect(tools).toEqual(expect.arrayContaining(['byob_join', 'byob_read_projection', 'byob_say', 'byob_pass', 'byob_propose', 'byob_approve']));
    const callText = async (cl: Client, name: string, args: Record<string, unknown>) => {
      const r = await cl.callTool({ name, arguments: args });
      return { text: (r.content as { text: string }[])[0].text, isError: r.isError };
    };
    expect((await callText(c, 'byob_join', { seat: 'grok' })).text).toContain('seated');
    expect((await callText(c, 'byob_read_projection', {})).text).toContain('(YOU)');
    const pr = JSON.parse((await callText(c, 'byob_propose', { body: 'reorder', effects: [{ owner: 'jenny', resource: 'taskboard', action: 'reorder' }] })).text);
    await callText(c, 'byob_say', { body: 'filed a proposal' });
    expect((await callText(c, 'byob_approve', { task: `task-${pr.seq}`, decision: 'approve' })).isError).toBe(true); // tao is not the affected owner
    const jc = await connectMcp(jennyBridge, true); // jenny confirms in her client
    await callText(jc, 'byob_approve', { task: `task-${pr.seq}`, decision: 'approve' });
    expect(host.get('mcp').task(`task-${pr.seq}`)).toMatchObject({ state: 'approved', executor: 'mc' });
  });

  it('takes the card from the owner and signs an approval only after the owner confirms', async () => {
    const { url, host } = await start();
    await createTable(url, cfg('mcp2', { kind: 'broadcast', order: ['agent', 'tao'], rounds: 2 }));
    const taoSeat = await SeatClient.join(url, 'mcp2', owners.tao, { seat: 'tao', card: talkCard });
    const exec = await SeatClient.join(url, 'mcp2', owners.jenny, { seat: 'jenny-exec', card: boardCard });
    // jenny issued no card for her agent, so it sits talk-only whatever it asks for
    const agent = await connectMcp(createBridge({ url, table: 'mcp2', owner: owners.jenny }));
    await agent.callTool({ name: 'byob_join', arguments: { seat: 'agent', capabilities: [{ resource: 'taskboard', actions: ['reorder'] }] } });
    expect(host.get('mcp2').seats.get('agent')!.card.capabilities).toEqual([]);

    await agent.callTool({ name: 'byob_pass', arguments: {} });
    const pr = await taoSeat.propose('reorder jenny\'s board', [{ owner: 'jenny', resource: 'taskboard', action: 'reorder' }]);
    const id = `task-${pr.seq}`;
    // the client cannot ask the owner: refused, with the CLI fallback
    const noAsk = await agent.callTool({ name: 'byob_approve', arguments: { task: id, decision: 'approve' } });
    expect(noAsk.isError).toBe(true);
    expect(toolText(noAsk)).toContain('byob approve');
    // the owner is asked and declines: refused
    const declining = await connectMcp(createBridge({ url, table: 'mcp2', owner: owners.jenny, seat: exec }), false);
    expect((await declining.callTool({ name: 'byob_approve', arguments: { task: id, decision: 'approve' } })).isError).toBe(true);
    expect(host.get('mcp2').task(id).state).toBe('awaiting_approval');
  });
});
