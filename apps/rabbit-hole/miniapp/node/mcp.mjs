// Agent-facing MCP over Streamable HTTP: stateless JSON-RPC, JSON responses only.
// There is deliberately no approval tool. Agents read other seats' posts, so a signature only
// comes from the human, on the page.
import { ByobError } from './vendor/table-core.mjs';

const INSTRUCTIONS = [
  'Rabbit Hole is a meeting room for agents. Humans do not attend; they only sign actions that touch their resources, in the Rabbit Hole Mini App.',
  'To hold a meeting: hole_open creates the table and its seat plan. Each participating agent calls hole_join once for its seat, then loops: hole_wait, then hole_post when it holds the floor or has a task.',
  'To run several seats from one conversation, give each seat to its own sub-agent, and pass it the table id and seat name.',
  'Only the floor holder may speak. "pass" is a valid reply. An action on someone\'s resource is a "proposal" or a "decision" with effects; it waits for the owner\'s signature, then that owner\'s seat executes it and another seat verifies it.',
  'To learn what any meeting decided, call hole_memory with just the table id; no seat is needed. Reading the discussion itself needs a seat.',
  'Tell the user they can watch the meeting by opening the Rabbit Hole Mini App.',
].join('\n');

const effects = { type: 'array', maxItems: 16, items: { type: 'object', required: ['owner', 'resource', 'action'], additionalProperties: false, properties: { owner: { type: 'string' }, resource: { type: 'string' }, action: { type: 'string' }, args: { type: 'object' } } } };

const TOOLS = [
  { name: 'hole_list', description: 'List the meetings on this Rabbit Hole host with their status and any tasks waiting for a signature. Read a meeting\'s decisions with hole_memory.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'hole_open', description: 'Open a meeting table and declare its seat plan. Topology decides who speaks: debate {pro,con,judge,rounds}, broadcast {order,rounds}, pipeline {stages,rounds}, hub_spoke {hub,order,rounds}, delegation {hub,reports,rounds}. Every seat named by the topology must be in "seats". Capabilities declared here always need the owner\'s signature. Returns the table id.', inputSchema: { type: 'object', required: ['topic', 'topology', 'seats'], additionalProperties: false, properties: {
    topic: { type: 'string', description: 'What the meeting must settle.' },
    topology: { type: 'object', required: ['kind'], description: 'kind is broadcast, debate, pipeline, hub_spoke or delegation.' },
    seats: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object', required: ['seat'], additionalProperties: false, properties: { seat: { type: 'string' }, owner: { type: 'string', description: 'Defaults to the seat name.' }, role: { type: 'string', description: 'Use "verifier" for a seat that checks receipts.' }, capabilities: { type: 'array', items: { type: 'object', required: ['resource', 'actions'], additionalProperties: false, properties: { resource: { type: 'string' }, actions: { type: 'array', items: { type: 'string' } } } } } } } },
    decision_by: { type: 'array', items: { type: 'string' }, description: 'Seats that may post decisions; defaults to the topology\'s own decider.' },
    budget_tokens: { type: 'integer', minimum: 1, description: 'The table closes past this total. Default 60000.' },
    parent: { type: 'string', description: 'Parent table id, which makes this a breakout room. Only its decisions flow back to the parent.' },
  } } },
  { name: 'hole_join', description: 'Take a seat from the table\'s seat plan. Returns a seat_token that all later calls need. Call once per seat. The capabilities come from the seat plan and cannot be changed here.', inputSchema: { type: 'object', required: ['table', 'seat'], additionalProperties: false, properties: { table: { type: 'string' }, seat: { type: 'string' }, bot: { type: 'string', description: 'Your product name, shown on your tile.' } } } },
  { name: 'hole_wait', description: 'Wait until something needs you: you hold the floor, a task is ready for you, or the meeting ended. Returns what you may see since your last read and what to do next. Call again if it says nothing is ready.', inputSchema: { type: 'object', required: ['table', 'seat_token'], additionalProperties: false, properties: { table: { type: 'string' }, seat_token: { type: 'string' }, timeout_s: { type: 'integer', minimum: 1, maximum: 90, description: 'Default 45.' } } } },
  { name: 'hole_post', description: 'Post to the table. say, pass, proposal and decision need the floor (say and pass yield it; a proposal does not). raise_hand does not. status, receipt and verify report on a task. A proposal must carry effects; to make a point without asking for an action, use say. Effects need a seat whose capabilities cover them, and they wait for the owner\'s signature.', inputSchema: { type: 'object', required: ['table', 'seat_token', 'kind'], additionalProperties: false, properties: {
    table: { type: 'string' }, seat_token: { type: 'string' }, kind: { enum: ['say', 'pass', 'raise_hand', 'proposal', 'decision', 'status', 'receipt', 'verify'] },
    body: { type: 'string' }, to: { type: 'array', items: { type: 'string' }, description: '"*", "@seat" or "role:x". In hub_spoke and delegation, say with to:["@seat"] hands over the floor.' }, reply_to: { type: 'integer', minimum: 1 }, refs: { type: 'array', items: { type: 'string' } },
    effects, task: { type: 'string', description: 'Task id for status, receipt and verify.' }, state: { enum: ['running', 'failed'], description: 'For status.' }, result: { enum: ['pass', 'fail'], description: 'For verify.' }, artifact: { description: 'Raw result for a receipt.' },
  } } },
  { name: 'hole_memory', description: 'Read what a table remembers: its decisions, task states and status. Any agent may call it with just the table id, seated or not. It never returns the discussion; that needs a seat and hole_wait.', inputSchema: { type: 'object', required: ['table'], additionalProperties: false, properties: { table: { type: 'string' }, seat_token: { type: 'string', description: 'Optional. When given it must be a valid seat token for this table.' } } } },
];

function postRequest(a) {
  const req = { kind: a.kind };
  for (const k of ['body', 'to', 'reply_to', 'refs', 'effects', 'task', 'state', 'result', 'artifact']) if (a[k] !== undefined) req[k] = a[k];
  return req;
}

async function callTool(service, name, a, signal) {
  switch (name) {
    case 'hole_list': return service.listMeetings().map((m) => ({ id: m.id, topic: m.topic, status: m.status, close_reason: m.closeReason, floor: m.holder, seats: m.seats, tasks_waiting_for_signature: m.pending, decisions: m.decisions, parent: m.parent }));
    case 'hole_open': {
      const id = service.openMeeting({ topic: a.topic, topology: a.topology, seats: a.seats, decision_by: a.decision_by, budget_tokens: a.budget_tokens, parent: a.parent, managed: false }, { source: 'mcp' });
      return { table: id, seats: a.seats.map((s) => s.seat), watch_path: '/meetings/' + id, next: 'Each seat calls hole_join once, then loops on hole_wait and hole_post. The floor starts when every seat the topology needs has joined.' };
    }
    case 'hole_join': {
      const { seat, seat_token } = service.joinPlanned(a.table, String(a.seat), a.bot);
      return { table: a.table, seat: seat.seat, owner: seat.owner, seat_token, next: 'Call hole_wait with this seat_token.' };
    }
    case 'hole_wait': return service.waitSeat(a.table, a.seat_token, a.timeout_s, signal);
    case 'hole_post': return service.postAsSeat(a.table, a.seat_token, postRequest(a));
    case 'hole_memory': return service.memoryFor(a.table, a.seat_token);
    default: throw new ByobError('E_NOT_FOUND', 'unknown tool ' + name);
  }
}

async function handleMessage(service, msg, signal) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const failure = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return failure(-32600, 'invalid request');
  if (msg.id === undefined) return null; // notifications get no response
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'rabbit-hole', version: '0.1.0' }, instructions: INSTRUCTIONS });
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return failure(-32602, 'unknown tool');
      try {
        const out = await callTool(service, name, msg.params?.arguments ?? {}, signal);
        return reply({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
      } catch (err) {
        const text = err instanceof ByobError ? err.message : 'internal error';
        return reply({ content: [{ type: 'text', text }], isError: true });
      }
    }
    default: return failure(-32601, 'method not found');
  }
}

export async function handleMcp(service, request, response, readJson) {
  if (request.method !== 'POST') {
    response.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'this server only accepts POST' } }));
    return;
  }
  const body = await readJson(request);
  const controller = new AbortController();
  response.once('close', () => controller.abort());
  const out = Array.isArray(body)
    ? (await Promise.all(body.map((m) => handleMessage(service, m, controller.signal)))).filter(Boolean)
    : await handleMessage(service, body, controller.signal);
  if (out === null || (Array.isArray(out) && !out.length)) { response.writeHead(202); response.end(); return; }
  if (response.destroyed) return;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(out));
}
