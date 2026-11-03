// Rabbit Hole Mini App, end to end: the real Node entry, real MCP clients over Streamable HTTP, and
// a scripted stand-in for the Host's Agent access. The table core is bundled from src/ first.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, describe, it, vi } from 'vitest';
import { buildMiniApp } from '../scripts/build-miniapp.mjs';

vi.setConfig({ testTimeout: 20000 });
const PKG = fileURLToPath(new URL('../apps/rabbit-hole', import.meta.url));
await buildMiniApp();
const { start } = await import(PKG + '/miniapp/node/server.mjs');
const freePort = () => new Promise((r) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(25); } throw new Error('timed out'); };

function fakeAgent(script) {
  const sessions = new Map(); let n = 0; const calls = [];
  return {
    calls, replies: [],
    async models() { return { models: [{ providerId: 'p', modelId: 'm', displayName: 'Model M' }], default: { providerId: 'p', modelId: 'm' } }; },
    async reply(x) { this.replies.push(x); },
    async run(input, opts = {}) {
      const sessionId = input.sessionId ?? 'sess-' + ++n;
      const seat = sessions.get(sessionId) ?? (input.text.match(/You are @([\w.-]+)/) ?? [])[1];
      sessions.set(sessionId, seat);
      calls.push({ seat, sessionId, text: input.text, model: input.model });
      opts.onEvent?.({ type: 'turn.started', sessionId, turnId: 't' + n, model: { modelId: 'm' } });
      const out = await script(seat, input.text, opts.signal, opts.onEvent, sessionId);
      if (opts.signal?.aborted) return { sessionId, turnId: 't', status: 'aborted' };
      return { sessionId, turnId: 't' + n, status: 'finished', text: out, model: { modelId: 'm' } };
    },
  };
}
async function boot(dataDir, agent) {
  const port = await freePort();
  const ac = new AbortController();
  const logs = [];
  const lc = await start({ pluginId: 'rabbit-hole', pluginRoot: PKG, dataDir, listen: { host: '127.0.0.1', port }, signal: ac.signal, logger: { info: (c) => logs.push(c), warn: (c) => logs.push(c), error: (c) => logs.push(c) }, agent });
  const base = 'http://127.0.0.1:' + port;
  const api = async (path, method = 'GET', body) => { const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  return { base, api, logs, stop: () => lc.dispose() };
}
async function mcpClient(base) {
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp/rabbit-hole')));
  const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); const text = r.content[0].text; let json; try { json = JSON.parse(text); } catch { json = undefined; } return { isError: !!r.isError, text, json }; };
  return { c, call };
}

// ---------- A: a whole meeting through real MCP clients ----------
describe('Rabbit Hole over MCP', async () => {
const dataA = mkdtempSync(join(tmpdir(), 'rh-a-'));
const A = await boot(dataA, fakeAgent(async () => '{}'));
const { c: mc, call } = await mcpClient(A.base);
let T, tok = {}, task;
it('MCP: official SDK client connects and lists 6 tools, with no way to sign', async () => {
  const names = (await mc.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['hole_join', 'hole_list', 'hole_memory', 'hole_open', 'hole_post', 'hole_wait']);
  assert.ok(mc.getInstructions().includes('Rabbit Hole'));
});
it('MCP: bad table configs come back as readable tool errors and store nothing', async () => {
  const a = await call('hole_open', { topic: 'x', topology: { kind: 'debate', pro: 'a' }, seats: [{ seat: 'a' }] });
  assert.ok(a.isError && /E_CONFIG/.test(a.text), a.text);
  const b = await call('hole_open', { topic: 'x', topology: { kind: 'debate', pro: 'a', con: 'zz' }, seats: [{ seat: 'a' }] });
  assert.ok(b.isError && /zz/.test(b.text), b.text);
  const c = await call('hole_open', { topic: 'x', topology: { kind: 'broadcast', order: ['core'] }, seats: [{ seat: 'core' }] });
  assert.ok(c.isError, 'reserved seat core must be refused');
  assert.deepEqual((await call('hole_list', {})).json, []);
});
it('MCP: open a table; a seat cannot join outside the plan; auto_approve in the plan is dropped', async () => {
  const r = await call('hole_open', { topic: 'Which issue first?', topology: { kind: 'debate', pro: 'pro', con: 'con', judge: 'judge', rounds: 1 },
    seats: [{ seat: 'pro', owner: 'tao' }, { seat: 'con', owner: 'jenny', capabilities: [{ resource: 'taskboard', actions: ['reorder'], auto_approve: true, requires_approval: false }] }, { seat: 'judge', owner: 'ops' }, { seat: 'checker', owner: 'ops', role: 'verifier' }] });
  assert.ok(!r.isError, r.text); T = r.json.table;
  const out = await call('hole_join', { table: T, seat: 'mallory' });
  assert.ok(out.isError && /seat plan/.test(out.text), out.text);
  for (const s of ['pro', 'con', 'judge', 'checker']) tok[s] = (await call('hole_join', { table: T, seat: s, bot: 'bot-' + s })).json.seat_token;
  assert.ok((await call('hole_join', { table: T, seat: 'pro' })).isError, 'a seat is taken only once');
  const snap = (await A.api('/api/tables/' + T)).body;
  assert.equal(snap.holder, 'pro');
  assert.equal(snap.seats.find((s) => s.seat === 'con').bot, 'bot-con');
});
it('MCP: floor control holds; wrong token and out-of-turn posts are refused', async () => {
  assert.ok((await call('hole_post', { table: T, seat_token: 'nope', kind: 'say', body: 'hi' })).isError);
  const w = await call('hole_post', { table: T, seat_token: tok.con, kind: 'say', body: 'me first' });
  assert.ok(w.isError && /E_NOT_FLOOR/.test(w.text), w.text);
  const pw = await call('hole_wait', { table: T, seat_token: tok.pro });
  assert.ok(/floor: pro \(you\)/.test(pw.text) && /Which issue first/.test(pw.text) && /next: You hold the floor/.test(pw.text), pw.text);
  assert.ok(!(await call('hole_post', { table: T, seat_token: tok.pro, kind: 'say', body: 'pro speaks', to: ['@judge'] })).isError);
  const cw = await call('hole_wait', { table: T, seat_token: tok.con, timeout_s: 2 });
  assert.ok(/pro speaks/.test(cw.text), cw.text);
  assert.ok(!(await call('hole_post', { table: T, seat_token: tok.con, kind: 'pass', body: 'nothing to add' })).isError);
});
it('MCP: hole_wait blocks until the seat is needed', async () => {
  const t0 = Date.now();
  const idle = await call('hole_wait', { table: T, seat_token: tok.checker, timeout_s: 1 });
  assert.ok(Date.now() - t0 >= 900 && /Nothing for you yet/.test(idle.text), idle.text);
});
it('Sign: the decision opens a task that waits for the human, even for a card that asked for auto-approval', async () => {
  const j = await call('hole_wait', { table: T, seat_token: tok.judge });
  assert.ok(/you may decide/.test(j.text), j.text);
  assert.ok(!/nothing to add/.test(j.text), 'the judge sees only the sides say entries');
  const d = await call('hole_post', { table: T, seat_token: tok.judge, kind: 'decision', body: 'pro wins', effects: [{ owner: 'jenny', resource: 'taskboard', action: 'reorder', args: { first: '#461' } }] });
  assert.ok(!d.isError, d.text); task = d.json.task;
  const snap = (await A.api('/api/tables/' + T)).body;
  assert.equal(snap.status, 'closed');
  assert.equal(snap.tasks[0].state, 'awaiting_approval');
  assert.equal(snap.tasks[0].plannedExecutor, 'con');
  assert.equal(snap.tasks[0].why, 'pro wins');
  assert.ok(!JSON.stringify(snap.entries).includes('"signature"') || !snap.entries.some((e) => e.data?.signature), 'no signatures on the page');
  assert.equal((await A.api('/api/tables/' + T + '/tasks/' + task + '/decision', 'POST', { decision: 'maybe' })).status, 400);
});
it('Sign -> execute -> verify over MCP: executor wakes on signature, executor cannot self-verify, checker verifies', async () => {
  const early = await call('hole_wait', { table: T, seat_token: tok.con, timeout_s: 1 });
  assert.ok(/awaiting_approval and may still need you/.test(early.text) && !/You can stop/.test(early.text), early.text);
  const waiting = call('hole_wait', { table: T, seat_token: tok.con, timeout_s: 10 });
  await sleep(100);
  const signed = await A.api('/api/tables/' + T + '/tasks/' + task + '/decision', 'POST', { decision: 'approve', reason: 'ok' });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(signed.body.state, 'approved');
  const woke = await waiting;
  assert.ok(new RegExp('The owner signed ' + task).test(woke.text), woke.text);
  assert.ok(!(await call('hole_post', { table: T, seat_token: tok.con, kind: 'status', task, state: 'running' })).isError);
  assert.ok(!(await call('hole_post', { table: T, seat_token: tok.con, kind: 'receipt', task, body: 'reordered', artifact: { first: '#461' } })).isError);
  const self = await call('hole_post', { table: T, seat_token: tok.con, kind: 'verify', task, result: 'pass' });
  assert.ok(self.isError && /E_SELF_VERIFY/.test(self.text), self.text);
  const cw = await call('hole_wait', { table: T, seat_token: tok.checker, timeout_s: 2 });
  assert.ok(new RegExp(task + ' has a receipt').test(cw.text), cw.text);
  assert.ok(!(await call('hole_post', { table: T, seat_token: tok.checker, kind: 'verify', task, result: 'pass', body: 'checked' })).isError);
  assert.equal((await A.api('/api/tables/' + T)).body.tasks[0].state, 'verified');
  assert.equal((await call('hole_memory', { table: T, seat_token: tok.pro })).json.decisions[0].body, 'pro wins');
});
it('MCP: any agent reads decisions and task states without a seat, never the discussion', async () => {
  const r = await call('hole_memory', { table: T });
  assert.ok(!r.isError, r.text);
  assert.equal(r.json.decisions[0].body, 'pro wins');
  assert.equal(r.json.tasks[0].state, 'verified');
  assert.ok(!r.text.includes('pro speaks') && !r.text.includes('nothing to add'), 'no transcript in memory');
  assert.ok((await call('hole_memory', { table: T, seat_token: 'nope' })).isError, 'a wrong token is still refused');
  assert.ok((await call('hole_memory', { table: 'hole-missing' })).isError);
});
it('Breakout: a child table reports only its decision to the parent', async () => {
  const main = (await call('hole_open', { topic: 'main', topology: { kind: 'broadcast', order: ['a', 'b'], rounds: 3 }, seats: [{ seat: 'a' }, { seat: 'b' }] })).json.table;
  const kid = (await call('hole_open', { topic: 'side', parent: main, topology: { kind: 'debate', pro: 'x', con: 'y', judge: 'x', rounds: 1 }, seats: [{ seat: 'x' }, { seat: 'y' }] })).json.table;
  const x = (await call('hole_join', { table: kid, seat: 'x' })).json.seat_token, y = (await call('hole_join', { table: kid, seat: 'y' })).json.seat_token;
  await call('hole_post', { table: kid, seat_token: x, kind: 'say', body: 'secret detail' });
  await call('hole_post', { table: kid, seat_token: y, kind: 'pass' });
  await call('hole_post', { table: kid, seat_token: x, kind: 'decision', body: 'use cursors' });
  const snap = (await A.api('/api/tables/' + main)).body;
  assert.deepEqual(snap.children.map((c) => c.decisions), [['use cursors']]);
  assert.ok(snap.entries.some((e) => e.event === 'subtable_result'));
  assert.ok(!JSON.stringify(snap.entries).includes('secret detail'));
});
it('MCP: a proposal without effects is refused with a hint to say it instead', async () => {
  const id = (await call('hole_open', { topic: '预算', topology: { kind: 'broadcast', order: ['a'], rounds: 2 }, seats: [{ seat: 'a' }] })).json.table;
  tok.zh = (await call('hole_join', { table: id, seat: 'a' })).json.seat_token;
  T = id;
  const bad = await call('hole_post', { table: id, seat_token: tok.zh, kind: 'proposal', body: 'just an idea' });
  assert.ok(bad.isError && /E_SCHEMA/.test(bad.text) && /kind "say"/.test(bad.text), bad.text);
  assert.ok(/proposal must carry effects/.test((await mc.listTools()).tools.find((t) => t.name === 'hole_post').description));
});
it('Budget: Chinese posted over MCP counts one token per character, not one per four', async () => {
  const zh = '我主张先做跨机入座，因为这决定产品成不成立。'.repeat(10);
  assert.ok(!(await call('hole_post', { table: T, seat_token: tok.zh, kind: 'say', body: zh })).isError);
  assert.equal((await A.api('/api/tables/' + T)).body.tokens, zh.length);
});
afterAll(async () => { await mc.close(); await A.stop(); });
});

// ---------- B: a meeting started from the page, driven by Agent turns ----------
describe('Rabbit Hole meetings started from the page', async () => {
const dataB = mkdtempSync(join(tmpdir(), 'rh-b-'));
const scriptB = async (seat, text, signal, onEvent, sessionId) => {
  if (/independent verifier/.test(text)) return '{"result":"pass","body":"I read the board"}';
  if (/signed this task/.test(text)) return 'I reordered the board.\n\n<deliver-assets><media src="/x"/></deliver-assets>';
  if (seat === 'judge') return 'Sure:\n{"kind":"decision","body":"go with pro","effects":[{"owner":"con","resource":"board","action":"reorder"}]}';
  onEvent?.({ type: 'text.delta', sessionId, turnId: 't', text: '{"kind":"say","body":"streaming ' });
  onEvent?.({ type: 'permission.requested', sessionId, turnId: 't', requestId: 'r1', toolName: 'bash', reason: 'x' });
  await sleep(150);
  return '{"kind":"say","body":"' + seat + ' argues","to":["@judge","@nobody"]}';
};
const agentB = fakeAgent(scriptB);
let B = await boot(dataB, agentB);
const sse = []; const ac = new AbortController();
fetch(B.base + '/api/events', { signal: ac.signal }).then(async (r) => { const dec = new TextDecoder(); for await (const c of r.body) sse.push(dec.decode(c)); }).catch(() => {});
await sleep(50);
let M;
it('Page: New meeting runs real turns seat by seat; first turn has the prefix and the brief, later turns only the tail', async () => {
  const created = await B.api('/api/tables', 'POST', { topic: 'Pick one', topology: { kind: 'debate', pro: 'pro', con: 'con', judge: 'judge', rounds: 2 },
    seats: [{ seat: 'pro', persona: 'argue for A', model: { providerId: 'p', modelId: 'm' }, modelLabel: 'Model M' }, { seat: 'con', capabilities: [{ resource: 'board', actions: ['reorder'] }] }, { seat: 'judge' }] });
  assert.equal(created.status, 201, JSON.stringify(created.body)); M = created.body.id;
  await until(async () => (await B.api('/api/tables/' + M)).body.status === 'closed');
  const proCalls = agentB.calls.filter((c) => c.seat === 'pro');
  assert.equal(proCalls.length, 2);
  assert.ok(/argue for A/.test(proCalls[0].text) && /Topic: Pick one/.test(proCalls[0].text) && /Do not call tools/.test(proCalls[0].text));
  assert.deepEqual(proCalls[0].model, { providerId: 'p', modelId: 'm' });
  assert.ok(!/Topic: Pick one/.test(proCalls[1].text) && /con argues/.test(proCalls[1].text), proCalls[1].text);
  assert.equal(proCalls[1].sessionId, proCalls[0].sessionId);
  const judge = agentB.calls.find((c) => c.seat === 'judge');
  assert.ok(/You are in decision_by/.test(judge.text));
});
it('Page: unknown addressees are dropped, tool asks are denied, captions and turn events stream', async () => {
  const snap = (await B.api('/api/tables/' + M)).body;
  const say = snap.entries.find((e) => e.kind === 'say' && e.seat === 'pro');
  assert.deepEqual(say.to, ['@judge']);
  assert.ok(agentB.replies.length >= 2 && agentB.replies.every((r) => r.decision === 'deny'));
  const stream = sse.join('');
  assert.ok(/event: caption/.test(stream) && /streaming /.test(stream) && !/\\"kind\\":\\"say/.test(stream.match(/event: caption[^\n]*\ndata: [^\n]*/)?.[0] ?? ''), 'caption shows speech, not JSON');
  assert.ok(/event: turn/.test(stream) && /event: entry/.test(stream));
});
it('Page: nothing executes until the human signs; signing runs execution then an independent verify', async () => {
  const before = agentB.calls.length;
  const snap = (await B.api('/api/tables/' + M)).body;
  assert.equal(snap.tasks[0].state, 'awaiting_approval');
  await sleep(150);
  assert.equal(agentB.calls.length, before, 'no agent turn before the signature');
  const id = snap.tasks[0].id;
  assert.equal((await B.api('/api/tables/' + M + '/tasks/' + id + '/decision', 'POST', { decision: 'approve' })).status, 200);
  await until(async () => (await B.api('/api/tables/' + M)).body.tasks[0].state === 'verified');
  const done = (await B.api('/api/tables/' + M)).body.tasks[0];
  assert.ok(!/deliver-assets/.test(done.receipt.body), 'delivery tags are stripped');
  assert.notEqual(done.verify.seat, done.executor);
});
it('Page: rejecting a task stops it; ending a meeting aborts the running turn and leaves no further turn', async () => {
  let release;
  const agent2Script = (seat, text, signal) => new Promise((res) => { release = () => res('{"kind":"pass"}'); signal?.addEventListener('abort', () => res('{"kind":"pass"}'), { once: true }); });
  const data2 = mkdtempSync(join(tmpdir(), 'rh-c-'));
  const a2 = fakeAgent(agent2Script); const S2 = await boot(data2, a2);
  const id = (await S2.api('/api/tables', 'POST', { topic: 'End me', topology: { kind: 'broadcast', order: ['a', 'b'], rounds: 3 }, seats: [{ seat: 'a' }, { seat: 'b' }] })).body.id;
  await until(async () => (await S2.api('/api/tables/' + id)).body.turns.length === 1);
  const closed = await S2.api('/api/tables/' + id + '/close', 'POST', {});
  assert.equal(closed.body.status, 'closed');
  await sleep(100);
  const snap = (await S2.api('/api/tables/' + id)).body;
  assert.equal(snap.turns.length, 0);
  assert.equal(a2.calls.length, 1);
  assert.ok(!snap.entries.some((e) => e.kind === 'pass'));
  await S2.stop();
});
it('Failure: an agent error yields the floor so the meeting keeps going', async () => {
  const data3 = mkdtempSync(join(tmpdir(), 'rh-d-'));
  const a3 = fakeAgent(async (seat) => { if (seat === 'a') { const e = new Error('nope'); e.code = 'NOT_PERMITTED'; throw e; } return '{"kind":"say","body":"b talks"}'; });
  const S3 = await boot(data3, a3);
  const id = (await S3.api('/api/tables', 'POST', { topic: 'Errors', topology: { kind: 'broadcast', order: ['a', 'b'], rounds: 1 }, seats: [{ seat: 'a' }, { seat: 'b' }] })).body.id;
  const snap = await until(async () => { const s = (await S3.api('/api/tables/' + id)).body; return s.status === 'closed' && s; });
  assert.ok(snap.entries.some((e) => e.kind === 'pass' && /NOT_PERMITTED/.test(e.body)));
  assert.ok(snap.entries.some((e) => e.body === 'b talks'));
  await S3.stop();
});
it('Restart: a stopped service resumes an open meeting from the ledger, keeps sessions and cursors', async () => {
  const data4 = mkdtempSync(join(tmpdir(), 'rh-e-'));
  let hang = true;
  const script = (seat, text, signal) => new Promise((res) => {
    if (seat === 'b' && hang) { signal?.addEventListener('abort', () => res('{"kind":"pass"}'), { once: true }); return; }
    res('{"kind":"say","body":"' + (seat ?? 'b') + ' said"}');
  });
  const a4 = fakeAgent(script); const S4 = await boot(data4, a4);
  const id = (await S4.api('/api/tables', 'POST', { topic: 'Resume', topology: { kind: 'broadcast', order: ['a', 'b'], rounds: 1 }, seats: [{ seat: 'a' }, { seat: 'b' }] })).body.id;
  await until(async () => (await S4.api('/api/tables/' + id)).body.holder === 'b' && a4.calls.some((c) => c.seat === 'b'));
  await S4.stop();
  hang = false;
  const a5 = fakeAgent(script); const S5 = await boot(data4, a5);
  const snap = await until(async () => { const s = (await S5.api('/api/tables/' + id)).body; return s.status === 'closed' && s; });
  assert.ok(snap.entries.some((e) => e.body === 'b said'));
  assert.equal(snap.entries.filter((e) => e.body === 'a said').length, 1, 'a does not speak twice');
  assert.ok(a5.calls.every((c) => (c.seat ?? 'b') === 'b'));
  assert.equal(a5.calls[0].sessionId, a4.calls.find((c) => c.seat === 'b').sessionId, 'the seat keeps its session');
  assert.ok(!/a said[\s\S]*a said/.test(a5.calls[0].text));
  await S5.stop();
});
it('Keys stay off the wire and the key file is private', async () => {
  const snap = JSON.stringify((await B.api('/api/tables/' + M)).body);
  const keys = JSON.parse(readFileSync(join(dataB, 'owner-keys.json'), 'utf8'));
  for (const k of Object.values(keys)) assert.ok(!snap.includes(k.privateKey));
  const { statSync } = await import('node:fs');
  assert.equal(statSync(join(dataB, 'owner-keys.json')).mode & 0o777, 0o600);
});
it('Budget: Chinese speech counts about one token per character, not one per four', async () => {
  const data6 = mkdtempSync(join(tmpdir(), 'rh-f-'));
  const zh = '我主张先做跨机入座，因为这决定产品成不成立。'.repeat(10);
  const a6 = fakeAgent(async () => JSON.stringify({ kind: 'say', body: zh }));
  const S6 = await boot(data6, a6);
  const id = (await S6.api('/api/tables', 'POST', { topic: 'Budget', topology: { kind: 'broadcast', order: ['a'], rounds: 1 }, seats: [{ seat: 'a' }] })).body.id;
  const snap = await until(async () => { const s = (await S6.api('/api/tables/' + id)).body; return s.status === 'closed' && s; });
  assert.ok(snap.tokens >= zh.length * 0.9, 'tokens ' + snap.tokens + ' for ' + zh.length + ' characters');
  await S6.stop();
});
it('Static and routes: the page, assets and unknown routes behave', async () => {
  const page = await fetch(B.base + '/meetings'); assert.equal(page.status, 200);
  assert.equal((await B.api('/api/nope')).status, 404);
  assert.equal((await B.api('/api/tables/none')).status, 404);
  assert.equal((await fetch(B.base + '/mcp/rabbit-hole')).status, 405);
  assert.deepEqual((await B.api('/api/models')).body.models[0].displayName, 'Model M');
});
afterAll(async () => { ac.abort(); await B.stop(); });
});

// ---------- C: page text and seat display ----------
const { MESSAGES, pickLang } = await import(PKG + '/miniapp/client/i18n.js');
const { chipLabels, seatDetail } = await import(PKG + '/miniapp/client/seats.js');
const CJK = /[\u3000-\u9fff]/;
describe('Rabbit Hole page text and seat display', () => {
  it('i18n: Chinese and English have the same keys, and each message takes the same arguments', () => {
    assert.deepEqual(Object.keys(MESSAGES.en).sort(), Object.keys(MESSAGES.zh).sort());
    for (const [k, zh] of Object.entries(MESSAGES.zh)) {
      const en = MESSAGES.en[k];
      assert.equal(typeof en, typeof zh, k);
      if (typeof zh === 'function') assert.equal(en.length, zh.length, k);
      else assert.ok(!CJK.test(en), 'English text for ' + k + ' contains Chinese');
    }
  });
  it('i18n: page text lives only in i18n.js, and every key app.js and index.html use exists', () => {
    const app = readFileSync(PKG + '/miniapp/client/app.js', 'utf8');
    const html = readFileSync(PKG + '/miniapp/client/index.html', 'utf8');
    for (const [name, text] of [['app.js', app], ['index.html', html], ['seats.js', readFileSync(PKG + '/miniapp/client/seats.js', 'utf8')]]) {
      const line = text.split('\n').findIndex((l) => CJK.test(l));
      assert.equal(line, -1, name + ':' + (line + 1) + ' has untranslated text');
    }
    const keys = [...app.matchAll(/\btr\('([^']+)'\s*[,)]/g), ...html.matchAll(/data-i18n(?:-placeholder|-label)?="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(keys.length > 100);
    assert.deepEqual(keys.filter((k) => !(k in MESSAGES.zh)), []);
    // Keys built at runtime, such as tr('kind.' + e.kind), need at least one entry under their prefix.
    const prefixes = [...app.matchAll(/\btr\('([^']+\.)'\s*\+/g)].map((m) => m[1]);
    assert.ok(prefixes.length >= 5);
    assert.deepEqual(prefixes.filter((p) => !Object.keys(MESSAGES.zh).some((k) => k.startsWith(p))), []);
  });
  it('i18n: the Host language picks the table, and anything else falls back to English', () => {
    assert.equal(pickLang('zh-Hans'), 'zh');
    assert.equal(pickLang('zh-CN'), 'zh');
    assert.equal(pickLang('en'), 'en');
    assert.equal(pickLang('en-US'), 'en');
    assert.equal(pickLang('fr'), 'en');
    assert.equal(pickLang(undefined), 'en');
  });
  it('Seats: avatar letters stay distinct when seats share a first letter', () => {
    assert.deepEqual(chipLabels(['grok', 'gemini', 'opus']), { grok: 'GR', gemini: 'GE', opus: 'O' });
    assert.deepEqual(chipLabels(['seat1', 'seat2', 'seat3']), { seat1: 'S1', seat2: 'S2', seat3: 'S3' });
    assert.deepEqual(chipLabels(['pro', 'con', 'judge']), { pro: 'P', con: 'C', judge: 'J' });
    for (const names of [['pro', 'proxy'], ['a', 'A'], ['gab', 'gac', 'gbx'], ['x', 'x1', 'x2', 'X2']]) {
      const labels = Object.values(chipLabels(names));
      assert.equal(new Set(labels).size, names.length, names.join(',') + ' -> ' + labels.join(','));
    }
  });
  it('Seats: the name tag shows the page model, otherwise the bot name the agent gave at hole_join', () => {
    assert.equal(seatDetail({ model: 'Model M', bot: 'MiniMax Code' }), 'Model M');
    assert.equal(seatDetail({ model: null, bot: 'Grok 4.7 · xAI' }), 'Grok 4.7 · xAI');
    assert.equal(seatDetail({ model: null, bot: null }), null);
  });
});
