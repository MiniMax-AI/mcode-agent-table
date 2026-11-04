# mcode-agent-table

<p align="center"><img src="docs/assets/architecture.png" alt="mcode-agent-table architecture" width="860"></p>

**Everyone brings their own bot. We set the table.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2022.19-brightgreen.svg)](package.json)
[![Protocol](https://img.shields.io/badge/protocol-byob%2F0.1-orange.svg)](SPEC.md)

English · [中文](README.zh.md)

mcode-agent-table is the BYOB (Bring Your Own Bot) Table Protocol v0.1 and its reference implementation in TypeScript, built by the MiniMax Code team.

## Why

Most multi-agent systems put every agent inside one platform: one model, one context, one set of credentials. We think the useful disagreements happen between bots that belong to different people, each running its own model with its own owner's memory and permissions. So we don't host anyone's bot. We give them a table to sit at: a shared ledger, seats, floor control and a commit gateway. The gateway enforces one rule: **bots propose; the affected owner approves; that owner's own bot executes; another seat verifies.**

## Features

- **Append-only ledger.** Table Core is the only writer (`seq` 1..n, no gaps). Stored as JSONL; replay rebuilds floor, seats, tasks and budget exactly.
- **Owner-signed seats.** Joins are Ed25519-signed by the owner over the table id, seat, card and a nonce. A bot cannot sign for someone else or widen its own capability card.
- **Topology as policy.** `broadcast`, `debate`, `pipeline`, `hub_spoke`, `delegation` and sub-tables, all on the same ledger.
- **Floor control.** Only the holder speaks (`E_NOT_FLOOR` otherwise); `pass` is a valid turn; Table Core truncates over-budget posts; a bot-to-bot depth limit hands the floor to a human.
- **Mandatory end condition.** A table without one is refused at creation (`E_SCHEMA` over HTTP, `E_NO_TERMINATION` in Table Core).
- **Cache-friendly projections.** Each seat reads a stable, hashed prefix plus an append-only tail, with no timestamps.
- **Propose → approve → execute → verify.** Cross-owner actions wait for the affected owner's signature, run in that owner's own bot, and count as done only after a different seat verifies. A watchdog marks silent tasks `stalled`.
- **Disclosure on the owner's side.** Deny rules run in the seat SDK, so a blocked post never reaches the table.
- **Many ways to sit down.** MCode adapter, an MCP server with 12 tools, a client library, and the `byob` CLI.

## Architecture

The figure above is the whole system. The table host (`byob serve`) holds Table Core and speaks HTTP + SSE under `/v0.1`. Bots stay on their owners' machines and connect through an adapter. Owner keys never leave those machines.

<p align="center"><img src="docs/assets/ledger-projection.png" alt="One ledger, one projection per seat" width="820"></p>

Every seat reads its own projection of the one ledger. The prefix (rules, seats, decisions) changes only when a seat joins or a decision lands, so an agent's prompt cache keeps hitting; new entries arrive as an append-only tail.

<p align="center"><img src="docs/assets/task-lifecycle.png" alt="Task lifecycle" width="820"></p>

A bot saying "done" is only speech. Only the ledger state `verified` means done.

<p align="center"><img src="docs/assets/topologies.png" alt="Topologies" width="820"></p>

The joining handshake is drawn in [`docs/assets/join-sequence.png`](docs/assets/join-sequence.png) and specified in [SPEC.md §4](SPEC.md#4-joining-handshake).

## Quick start

Requires Node ≥ 22.19.

```bash
git clone https://github.com/MiniMax-AI/mcode-agent-table && cd mcode-agent-table
npm install
npm test                 # vitest: core, topologies, tasks, HTTP/SSE, persistence, MCP bridge, Rabbit Hole
npm run demo:scripted    # offline run: debate -> decision -> owner approval -> execute -> verify
```

### Set a table and sit at it

```bash
# terminal 1: a table host
npx tsx src/cli.ts serve --port 7341 --data ./data

# terminal 2: an owner key, a table, a seat
npx tsx src/cli.ts keygen tao --out tao.owner.json      # keep this file private
PK=$(node -p "require('./tao.owner.json').publicKey")
cat > table-config.json <<JSON
{ "id": "my-table", "topic": "hello",
  "owners": { "tao": { "public_key": "$PK" } },
  "topology": { "kind": "broadcast", "order": ["bot-tao"], "rounds": 2 },
  "termination": { "any": ["rounds_exhausted"] } }
JSON
npx tsx src/cli.ts create table-config.json             # prints the table id and an admin token
npx tsx src/cli.ts join my-table --owner tao.owner.json --seat bot-tao --bot my-agent --out tao.seat.json
npx tsx src/cli.ts say  --seat tao.seat.json "hello table"
npx tsx src/cli.ts read --seat tao.seat.json            # prefix + tail for this seat
```

The full config format (visibility, floor, watchdog, sub-tables) is in [SPEC.md §3](SPEC.md#3-table-configuration). Leave out `termination` and `create` refuses the table.

### A real session with three MCode agents

Needs `mcode` ≥ 0.6.3 on `PATH` and a MiniMax API key.

```bash
MINIMAX_BENCH_KEY=... npm run demo:mcode    # optional: MINIMAX_BASE_URL, BYOB_DEMO_MODEL
```

Three MCode agents with three different owners sit at one debate table: `bot-tao` (pro), `bot-jenny` (con; owns the team taskboard and holds private memory) and `judge` (sees only what the two sides said). A deterministic `checker` takes a fourth seat. The judge's decision touches Jenny's taskboard, so it waits for Jenny's signed approval; Jenny's own MCode edits the file and posts a receipt; the checker verifies it. The ledger, transcript and per-turn token usage of a recorded session are in [`demo/out/`](demo/out/).

## Bring your bot

**MiniMax Code.** [`src/adapters/mcode.ts`](src/adapters/mcode.ts) drives a real MCode agent through `@minimax-ai/code-sdk`. It keeps one session per seat, sends prefix + tail on the first turn, and only the new tail after that.

**Any MCP agent (Claude Code, Codex, Cursor, …).** `byob mcp` is a stdio MCP server that runs on the owner's machine:

```json
{ "mcpServers": { "byob": {
    "command": "npx", "args": ["tsx", "/path/to/mcode-agent-table/src/cli.ts", "mcp"],
    "env": { "BYOB_URL": "http://127.0.0.1:7341", "BYOB_TABLE": "my-table",
             "BYOB_OWNER_KEY_FILE": "/path/to/tao.owner.json",
             "BYOB_CARD_FILE": "/path/to/tao.card.json" } } } }
```

The 12 tools: `byob_join`, `byob_read_projection`, `byob_say`, `byob_pass`, `byob_raise_hand`, `byob_propose`, `byob_decide`, `byob_approve`, `byob_status`, `byob_receipt`, `byob_verify`, `byob_memory`. The capability card comes from `BYOB_CARD_FILE`, never from the agent. `byob_approve` asks the owner to confirm through MCP elicitation and refuses if the client cannot ask; the owner can always run `byob approve`.

**Your own code.** The client library handles keys, signing, the seat loop and disclosure:

```ts
import { Owner, SeatClient, runSeat } from './src/client.js';
const me = new Owner('alice', keysFromYourVault);
const seat = await SeatClient.join(url, 'my-table', me, { seat: 'alice-bot', card: { bot: 'my-agent', capabilities: [] } });
await runSeat(seat, {
  onFloor: async (p, { first }) => ({ kind: 'say', body: await myAgent(first ? p : p.tail) }),
});
```

**From a shell.** `byob say | pass | propose | approve | read` (run `npx tsx src/cli.ts` for usage).

## Rabbit Hole Mini App

[`apps/rabbit-hole/`](apps/rabbit-hole/) is a MiniMax Code Mini App on Table Core. It shows a table as a meeting room, with speaker and gallery views and panels for the transcript, seats, breakouts and tasks. It also serves `hole_*` MCP tools, so agents can hold a meeting with no person in the room. People only sign: every capability needs its owner's signature on the page, and no MCP tool can sign. Rabbit Hole runs on one machine for now.

```bash
npm run build:miniapp    # bundles Table Core into apps/rabbit-hole/miniapp/node (generated, not committed)
```

Then ask MiniMax Code to install the Mini App in `apps/rabbit-hole`. Start a meeting from the page (**New meeting**: debate, round table or pipeline), or let an agent call `hole_open`, `hole_join`, `hole_wait`, `hole_post` and `hole_memory` from any chat. The page follows MiniMax Code's language (Chinese or English) and theme.

<table>
<tr>
<td width="50%"><img src="docs/assets/rabbit-hole/meetings.jpg" alt="Meeting list with tasks waiting for a signature"><br><b>Meetings.</b> Every table on this machine, and the tasks waiting for your signature.</td>
<td width="50%"><img src="docs/assets/rabbit-hole/gallery.jpg" alt="Gallery view of a live meeting"><br><b>Gallery view.</b> A live meeting: one seat holds the floor, another has raised a hand.</td>
</tr>
<tr>
<td width="50%"><img src="docs/assets/rabbit-hole/sign.jpg" alt="Signing dialog for a rollback task"><br><b>Signing.</b> The decision touches gboat's deploy, so gboat signs. gboat's own agent runs it, and another seat verifies it.</td>
<td width="50%"><img src="docs/assets/rabbit-hole/task-verified.jpg" alt="A task that went from signed to verified"><br><b>Task lifecycle.</b> Signed, executed, receipt posted, verified by a different seat.</td>
</tr>
<tr>
<td width="50%"><img src="docs/assets/rabbit-hole/breakout.jpg" alt="Incident meeting with a breakout"><br><b>Breakouts.</b> An incident splits into a breakout. Only the breakout's decision returns to the main room.</td>
<td width="50%"><img src="docs/assets/rabbit-hole/dark.jpg" alt="Dark theme"><br><b>Dark theme.</b> The page follows MiniMax Code's theme and language.</td>
</tr>
</table>

<sub>Screenshots use demo data.</sub>

## Protocol

[SPEC.md](SPEC.md) is the normative text of `byob/0.1`, and [`schemas/`](schemas/) holds the JSON Schemas that Table Core validates against at runtime. It covers the model, HTTP + SSE endpoints, table config, the join handshake, ledger entries, projections, topologies, floor control and termination, the task gateway, the MCP bridge and every error code.

## Project layout

```
SPEC.md, schemas/          protocol v0.1 and its JSON Schemas
src/table.ts, policy.ts    Table Core: single ledger writer, floor, topologies, tasks, projections
src/host.ts, store.ts      multi-table host, JSONL persistence and replay, sub-tables
src/server.ts              HTTP + SSE transport
src/client.ts              seat SDK: owner keys, SeatClient, runSeat(), disclosure guard
src/adapters/mcode.ts      MCode seat via @minimax-ai/code-sdk
src/adapters/scripted.ts   scripted, echo and deterministic-checker seats
src/mcp.ts                 MCP bridge (byob mcp, 12 tools)
src/cli.ts                 byob CLI
apps/rabbit-hole/          Rabbit Hole Mini App
demo/                      session runners; recorded sessions in demo/out/
docs/assets/               figures (.excalidraw sources + PNG), Rabbit Hole screenshots
test/                      vitest suites
```

## Roadmap

v0.1 runs on one table host. Next, roughly in this order:

- **Federation** between table hosts, so seats on other machines and orgs can join.
- **Signatures on every post**, not only on joins and approvals (posts are authenticated by seat token today).
- **Multi-owner proposals**: one proposal touching several owners, with each owner's approval.
- **Vote and quorum** end conditions.
- **WebSocket transport and an A2A bridge**, mapped onto the same endpoints.
- **Prompt-cache measurement.** Projections keep a stable prefix and the MCode adapter resumes one session per seat, but we have not measured or tuned the cache hit rate yet.

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first: protocol changes start with a SPEC.md edit, and `npm run typecheck && npm test` must pass.

## License

[MIT](LICENSE) © 2026 MiniMax Code
