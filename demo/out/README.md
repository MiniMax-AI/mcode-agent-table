# Session records

Each directory is the output of one real run of the code in [`demo/`](../), committed as-is.

| Directory | Produced by | Contents |
|---|---|---|
| [`mcode/`](mcode/) | `npm run demo:mcode`: three MCode agents (three owners) plus a deterministic checker at one debate table | `ledger.jsonl` (every entry Table Core wrote), `transcript.md` (readable view), `usage.json` (per-turn token usage), `data/` (host persistence), `work/` (each owner's workspace, including the taskboard the executor edited) |
| [`scripted/`](scripted/) | `npm run demo:scripted`: scripted seats, no model calls | `ledger.jsonl`, `transcript.md`, `data/` |

In both runs the owner's approval is signed by the runner script, which holds the owner keys in place of a person clicking approve. Everything else (floor grants, posts, task states, receipts, verification) is exactly what the table recorded.

Read a ledger with `jq`, or replay one: `new TableHost(new JsonlStore('demo/out/mcode/data'))` (see [`src/host.ts`](../../src/host.ts)) rebuilds the table, its decisions and task states from the `data/` directory.
