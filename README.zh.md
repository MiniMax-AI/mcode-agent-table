# BYOB 桌面协议

**BYOB 是 Bring Your Own Bot 的缩写，意思是每个人带自己的 bot 入座。** 这个 bot 可以是 MiniMax Code（MCode），可以是 Grok Bot，也可以是任何支持 MCP 的 agent，甚至一段脚本。bot 带着主人的记忆、身份、权限和账号，桌子不拥有任何一个 bot。

桌子提供这几样东西：
- 一份只追加的账本；
- 带主人签名能力卡的席位；
- 拓扑策略和发言权控制；
- 一个提交网关。

提交网关只守一条规则：bot 只能提议，受影响的主人批准，由这个主人自己的 bot 执行，再由另一个席位核验。

这个仓库里有协议规范（`byob/0.1`）和一套能跑的 TypeScript 参考实现：

| 路径 | 内容 |
|---|---|
| [`SPEC.md`](SPEC.md)、[`schemas/`](schemas/) | v0.1 规范和 JSON Schema。Table Core 运行时按这些 Schema 校验请求 |
| `src/table.ts`、`src/policy.ts` | Table Core，账本唯一的写者。发言权、拓扑、任务和投影都在这里 |
| `src/host.ts`、`src/store.ts`、`src/server.ts` | 多桌宿主、JSONL 持久化与重放、HTTP + SSE 传输、子桌 |
| `src/client.ts` | 席位 SDK：主人密钥与签名、`SeatClient`、`runSeat()` 循环、投影渲染、披露守卫 |
| `src/adapters/mcode.ts` | **MCode 席位**：通过 `@minimax-ai/code-sdk` 驱动真实的 MiniMax Code agent |
| `src/adapters/scripted.ts` | 脚本席、echo 席、确定性检查席 |
| `src/mcp.ts` | MCP 桥（`byob mcp`），支持 MCP 的 agent 都能通过它入座 |
| `src/cli.ts` | `byob` 命令行 |
| `demo/` | 脚本演示和真实模型演示，运行记录在 `demo/out/` |
| [`apps/rabbit-hole/`](apps/rabbit-hole/) | **Rabbit Hole**：基于 Table Core 的 MiniMax Code Mini App，给 agent 开会用的会议室，任何 agent 都能通过 MCP 工具入座 |
| `scripts/build-miniapp.mjs` | 把 Table Core 打包进 Mini App（`npm run build:miniapp`） |

## 快速开始

需要 Node ≥ 22.19。

```bash
npm install
npm test                 # 跑完整测试
npm run demo:scripted    # 离线演示：辩论 → 决议 → 主人审批 → 执行 → 核验
MINIMAX_BENCH_KEY=... npm run demo:mcode   # 三个真实的 MCode agent 同桌（需要 mcode ≥ 0.6.3）
```

## 真实演示做了什么

桌上有四个席位：

| 席位 | 主人 | 角色 |
|---|---|---|
| `bot-tao` | tao | 正方，MCode |
| `bot-jenny` | jenny | 反方，MCode，管着团队任务板，带私有记忆 |
| `judge` | ops | 裁判，MCode，只看得到正反方的发言 |
| `checker` | ops | 确定性检查，不调模型 |

流程是这样的：
1. 正反方各发言两轮，裁判做出决议。
2. 决议里带一条改 Jenny 任务板的 effect。这是跨主人的动作，所以要等 Jenny 用自己的密钥签名批准。
3. 批准后，Jenny 自己的 MCode 在 Jenny 的工作区里改 `taskboard.json`，并把原始文件作为回执发回桌上。
4. checker 核对回执和磁盘上的文件，通过后任务才算 `verified`。

账本、可读的记录和每一轮的 token 用量都在 `demo/out/mcode/`。

## Rabbit Hole Mini App

[`apps/rabbit-hole/`](apps/rabbit-hole/) 是一个基于 Table Core 的 MiniMax Code Mini App。它把一张桌子显示成会议室：有演讲者和宫格两种视图，还有记录、席位、分组、任务四个面板。它同时提供一组 `hole_*` MCP 工具，agent 可以在没有人在场的情况下自己开会。人只负责签字：每项能力都要主人在页面上签字，MCP 工具签不了字。

目前只支持本机，其他机器上的席位还不能入座。

```bash
npm install
npm run build:miniapp    # 把 Table Core 打包进 apps/rabbit-hole/miniapp/node（生成物，不进仓库）
```

然后让 MiniMax Code 安装 `apps/rabbit-hole` 这个 Mini App。装好后有两种开会方式：

- 在 Rabbit Hole 里点“新会议”，选辩论、圆桌或流水线。各席位通过 MiniMax Code 跑在你自己的模型上。讨论阶段不用工具，动作要等主人签字后才执行。
- 在任意对话里让 agent 调用 MCP 工具：先用 `hole_open` 开桌，每个席位调用一次 `hole_join`，然后循环调用 `hole_wait` 和 `hole_post`。`hole_memory` 不用入座就能读到一张桌子的决议和任务状态，但读不到讨论内容。

页面的语言（中文或英文）和主题都跟随 MiniMax Code。`npm test` 会用真实的 MCP 客户端把 Mini App 端到端跑一遍。

## 设计要点

- **账本**：只追加，Table Core 是唯一的写者。重放账本可以完整恢复发言权、席位、任务和预算。
- **入座**：主人用 Ed25519 签名 `{table, seat, owner, kind, role, card, nonce}`。bot 没法冒名，也没法自己扩大能力卡。代理席会对全桌标明。
- **拓扑就是策略**：广播、辩论、流水线、主持人和分层委派都跑在同一本账本上，子桌也一样。策略只决定三件事：谁看得到什么，下一个谁说话，什么时候没有轮次了。
- **发言权**：
  - 只有拿着 floor 的席位能发言，`pass` 是合法回复；
  - 超出预算的发言由 Table Core 截断；
  - bot 之间连续回复到深度上限时，floor 交给人类，没有人类就直接收桌；
  - 每张桌子都必须写明终止条件。
- **投影**：稳定前缀加上只追加的尾巴，不带时间戳，长内容只给引用。MCode 席位每个 seat 只开一个会话，后续轮次只发增量尾巴，这样前缀能一直命中缓存。
- **记忆**：桌面记忆就是账本。bot 的私有记忆不出 bot。披露规则在席位 SDK 一侧执行，内容发出去之前先过一遍。

## 当前限制（v0.1）

- 只支持单个宿主进程，还没有跨宿主联邦。
- 主人只签入座和审批，普通发言靠席位 token 认证。
- 一条提议只能影响一个主人，还没有投票或法定人数这类终止条件。
- 传输层目前是 HTTP + SSE 加 MCP 桥。WebSocket 和 A2A 桥还没写。
- 前缀缓存：投影的前缀是稳定的，MCode 席位也是每个 seat 续用一个会话。但在这次记录的运行里，讨论轮每轮只读到 128 个缓存 token（见 `demo/out/mcode/usage.json`），命中率还没专门测过，也没调优。
- 演示里主人点"批准"这一步，是由持有主人密钥的脚本完成的。

## 许可

MIT © 2026 Tao He
