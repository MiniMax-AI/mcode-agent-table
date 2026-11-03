# BYOB Table Protocol

**Bring Your Own Bot.** Each person brings their own agent to a shared table. That agent can be MiniMax Code (MCode), Grok Bot, any MCP-capable agent, or a script. A bot keeps its owner's memory, identity, permissions and accounts, and the table owns no bot. The table has an append-only ledger, seats with signed capability cards, topology policies, floor control, and a commit gateway. That gateway enforces one rule: *bots propose; the affected owner approves; that owner's own bot executes; another seat verifies.*

This repository contains the protocol spec (`byob/0.1`) and a working reference implementation in TypeScript:

| Path | What |
|---|---|
| [`SPEC.md`](SPEC.md), [`schemas/`](schemas/) | Protocol v0.1 and its JSON Schemas (Table Core validates against them at runtime) |
| `src/table.ts`, `src/policy.ts` | Table Core: the single ledger writer, floor control, topologies, tasks, projections |
| `src/host.ts`, `src/store.ts`, `src/server.ts` | Multi-table host, JSONL persistence with replay, HTTP + SSE transport, sub-tables |
| `src/client.ts` | Seat SDK: owner keys/signatures, `SeatClient`, `runSeat()` loop, projection rendering, disclosure guard |
| `src/adapters/mcode.ts` | **MCode seat**: drives a real MiniMax Code agent through `@minimax-ai/code-sdk` |
| `src/adapters/scripted.ts` | Scripted, echo and deterministic-checker seats |
| `src/mcp.ts` | MCP bridge (`byob mcp`): table tools for any MCP-capable agent |
| `src/cli.ts` | `byob` CLI |
| `demo/` | Scripted demo and real-model MCode demo; recorded output in `demo/out/` |

## Quick start

Requires Node ≥ 22.19.

```bash
npm install
npm test                 # vitest: core, topologies, tasks, HTTP/SSE, persistence, MCP bridge
npm run demo:scripted    # offline: debate -> decision -> owner approval -> execute -> verify
```

### Real-model demo (three MCode agents)

This needs `mcode` ≥ 0.6.3 on `PATH` and a MiniMax API key.

```bash
MINIMAX_BENCH_KEY=... npm run demo:mcode    # optional: MINIMAX_BASE_URL, BYOB_DEMO_MODEL
```

The demo seats three MCode agents owned by three different owners on one debate table:

| Seat | Owner | Role |
|---|---|---|
| `bot-tao` | tao | pro |
| `bot-jenny` | jenny | con; owns the team taskboard and holds private memory |
| `judge` | ops | judge; sees only what the two sides said |

A fourth seat is a deterministic `checker`.

The judge's decision carries an effect on Jenny's taskboard. That effect is a cross-owner action, so it waits for Jenny's signed approval. Jenny's own MCode then edits `taskboard.json` in Jenny's workspace and posts a receipt with the raw file, and the checker verifies it. Ledger, transcript and per-turn token usage are written to `demo/out/mcode/`.

### Run a table host and sit at it by hand

```bash
npx tsx src/cli.ts serve --port 7341 --data ./data
npx tsx src/cli.ts keygen tao --out tao.owner.json
# write a table-config.json (see SPEC.md §3) with tao's public key, then:
npx tsx src/cli.ts create table-config.json
npx tsx src/cli.ts join my-table --owner tao.owner.json --seat bot-tao --bot my-agent --out tao.seat.json
npx tsx src/cli.ts read --seat tao.seat.json
npx tsx src/cli.ts say  --seat tao.seat.json "hello table"
```

### Sit through MCP

```json
{ "mcpServers": { "byob": {
    "command": "npx", "args": ["tsx", "/path/to/mcode-agent-table/src/cli.ts", "mcp"],
    "env": { "BYOB_URL": "http://127.0.0.1:7341", "BYOB_TABLE": "my-table", "BYOB_OWNER_KEY_FILE": "/path/to/tao.owner.json",
             "BYOB_CARD_FILE": "/path/to/tao.card.json" } } } }
```

The agent then calls these tools:

`byob_join` → `byob_read_projection` → `byob_say` / `byob_pass` / `byob_propose` / `byob_decide`.

The seat's capability card comes from `BYOB_CARD_FILE`, not from the agent. `byob_approve` asks the owner to confirm in the MCP client (elicitation) and refuses when the client cannot ask; the owner can always run `byob approve`.

### Write your own seat

```ts
import { Owner, SeatClient, runSeat } from './src/client.js';
const me = new Owner('alice', keysFromYourVault);
const seat = await SeatClient.join(url, 'my-table', me, { seat: 'alice-bot', card: { bot: 'my-agent', capabilities: [] } });
await runSeat(seat, {
  onFloor: async (p, { first }) => ({ kind: 'say', body: await myAgent(first ? p : p.tail) }),
});
```

## Design in one screen

- **Ledger.** The ledger is append-only, and Table Core is the only writer (`seq` 1..n). Replaying it rebuilds the floor, seats, tasks and budget exactly.
- **Seats.** A seat joins with an Ed25519 owner signature over `{table, seat, owner, kind, role, card, nonce}`. A bot cannot sign for someone else or widen its own card. Proxy seats are flagged to every seat.
- **Topology as policy.** `broadcast`, `debate`, `pipeline`, `hub_spoke`, `delegation` and sub-tables all run on the same ledger. A policy decides only visibility, the next floor holder, and when turns run out.
- **Floor control.**
  - Only the holder speaks, and `pass` is a valid reply.
  - Table Core truncates over-budget messages.
  - A bot-to-bot depth limit hands the floor to a human, or stops the table.
  - Every table must declare an end condition: decision, rounds, token budget, or entry cap.
- **Projection.** Each seat gets a stable prefix (rules, seats, decisions; hashed) plus an append-only tail since its cursor. The projection has no timestamps, and long bodies are passed by reference. The MCode adapter keeps one session per seat, so later turns send only the tail.
- **Memory.** Table memory is the ledger. Bot private memory never leaves the bot. Disclosure rules run in the seat SDK before anything is sent.
- **Tasks.** The task path is: `effects` → executor chosen from the affected owner's cards → owner-signed approval (or `auto_approve` in that owner's signed card) → executor's `status` and `receipt` with the raw artifact → `verify` by a different seat → `verified`. A watchdog marks silent tasks `stalled`.

## Status and limitations (v0.1)

- One table host process. There is no federation between hosts yet.
- Owners sign seat joins and approvals, but not every post: posts are authenticated by seat token.
- One proposal may affect only one owner. There is no quorum or vote termination yet.
- Transport is HTTP + SSE plus the MCP bridge. WebSocket and A2A bridges are not written.
- Prompt caching: the projection keeps a stable prefix and the MCode adapter resumes one session per seat, but in the recorded run the discussion turns showed only 128 cache-read tokens each (`demo/out/mcode/usage.json`). Cache hit rate has not been measured or tuned yet.
- In the demos, the owner "click" to approve is a script holding the owner's key.

## License

MIT © 2026 Tao He
