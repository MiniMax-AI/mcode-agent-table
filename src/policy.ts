// Topology = policy over one ledger. A policy decides (1) visibility of floor-plane entries,
// (2) who holds the floor next, (3) when the rounds are exhausted. Its state is a plain JSON
// object stored in every `floor_granted` ledger entry, so a table can be rebuilt by replay.
import type { Entry, TableConfig } from './protocol.js';
import { ByobError } from './protocol.js';

export type PolicyState = Record<string, unknown> & { idx: number; queue?: string[]; stack?: string[]; hub_turns?: number };
export type Next = { holder: string } | { end: 'rounds_exhausted' };

export interface Policy {
  /** Seats that must be seated before the first floor grant. */
  required(): string[];
  /** Default decider seats when floor.decision_by is not configured. */
  deciders(): string[];
  init(): PolicyState;
  current(s: PolicyState): Next;
  /** Advance after the floor holder finished a turn with `e` (say | pass | decision). */
  after(s: PolicyState, e: Entry): PolicyState;
  raiseHand(s: PolicyState, seat: string): PolicyState;
  /** Default visibility for say / pass / raise_hand entries. */
  visible(e: Entry, viewer: string): boolean;
  /** Validate addressing on a say before it is appended. */
  checkAddress?(s: PolicyState, holder: string, to: string[] | undefined): void;
}

const addressed = (e: Entry, seat: string) => (e.to ?? []).includes('@' + seat);

/** Fixed speaking sequence; shared by broadcast, debate, pipeline. */
function sequenced(seq: string[], visible: Policy['visible'], deciders: string[], required = [...new Set(seq)]): Policy {
  return {
    required: () => required,
    deciders: () => deciders,
    init: () => ({ idx: 0, queue: [] }),
    current: s => (s.serving && s.queue?.length ? { holder: s.queue[0] } : s.idx < seq.length ? { holder: seq[s.idx] } : { end: 'rounds_exhausted' }),
    // A raised hand is served right after the current turn, without consuming the fixed sequence.
    after: s => {
      const n = s.serving ? { ...s, queue: (s.queue ?? []).slice(1) } : { ...s, idx: s.idx + 1 };
      return { ...n, serving: (n.queue?.length ?? 0) > 0 };
    },
    raiseHand: (s, seat) => (s.queue?.includes(seat) ? s : { ...s, queue: [...(s.queue ?? []), seat] }),
    visible,
  };
}

export function makePolicy(cfg: TableConfig): Policy {
  const t = cfg.topology;
  const rounds = t.rounds ?? 1;
  const need = (v: unknown, name: string) => { if (!v) throw new ByobError('E_CONFIG', `topology.${t.kind} requires ${name}`); };
  switch (t.kind) {
    case 'broadcast': {
      need(t.order?.length, 'order');
      const seq = Array.from({ length: rounds }, () => t.order!).flat();
      return sequenced(seq, () => true, []);
    }
    case 'debate': {
      need(t.pro, 'pro'); need(t.con, 'con');
      const seq = Array.from({ length: rounds }, () => [t.pro!, t.con!]).flat();
      if (t.judge) seq.push(t.judge);
      // Default: the judge sees only what the two sides said, nothing else on the floor plane.
      const vis = (e: Entry, viewer: string) =>
        viewer !== t.judge || e.seat === t.judge || ((e.seat === t.pro || e.seat === t.con) && e.kind === 'say');
      return sequenced(seq, vis, t.judge ? [t.judge] : []);
    }
    case 'pipeline': {
      need(t.stages?.length, 'stages');
      const st = t.stages!;
      // Stage i sees its own entries and stage i-1's output; non-stage seats (observers, humans) see all.
      const vis = (e: Entry, viewer: string) => {
        const i = st.indexOf(viewer);
        return i < 0 || e.seat === viewer || (i > 0 && e.seat === st[i - 1]) || addressed(e, viewer);
      };
      const seq = Array.from({ length: rounds }, () => st).flat();
      return sequenced(seq, vis, [st[st.length - 1]]);
    }
    case 'hub_spoke':
    case 'delegation': {
      let reports: Record<string, string[]>;
      let root: string;
      if (t.kind === 'hub_spoke') {
        need(t.hub, 'hub'); need(t.order?.length, 'order (spokes)');
        root = t.hub!; reports = { [root]: t.order! };
      } else {
        need(t.hub, 'hub (root)'); need(t.reports, 'reports');
        root = t.hub!; reports = t.reports!;
      }
      const managerOf = (s: string) => Object.keys(reports).find(m => reports[m].includes(s));
      const all = [...new Set([root, ...Object.values(reports).flat(), ...Object.keys(reports)])];
      const p: Policy = {
        required: () => all,
        deciders: () => [root],
        init: () => ({ idx: 0, stack: [], hub_turns: 0, cur: root }),
        current: s => (s.done ? { end: 'rounds_exhausted' } : { holder: s.cur as string }),
        after: (s, e) => {
          const cur = s.cur as string;
          const target = (e.to ?? []).map(a => a.slice(1)).find(x => (reports[cur] ?? []).includes(x));
          const hubTurns = (s.hub_turns ?? 0) + (cur === root ? 1 : 0);
          if (e.kind === 'say' && target) return { ...s, hub_turns: hubTurns, stack: [...(s.stack ?? []), cur], cur: target };
          if (cur === root) {
            if (e.kind === 'pass' || hubTurns >= rounds) return { ...s, hub_turns: hubTurns, done: true };
            return { ...s, hub_turns: hubTurns };
          }
          const stack = [...(s.stack ?? [])];
          const back = stack.pop() ?? root;
          return { ...s, stack, cur: back };
        },
        raiseHand: s => s,
        visible: (e, viewer) => {
          if (e.seat === viewer || addressed(e, viewer)) return true;
          if (managerOf(viewer) === e.seat) return true;
          return (reports[viewer] ?? []).includes(e.seat);
        },
        checkAddress: (s, holder, to) => {
          for (const a of to ?? []) {
            if (a === '*' || a.startsWith('role:')) continue;
            const x = a.slice(1);
            if (!all.includes(x)) throw new ByobError('E_ADDRESS', `${a} is not a seat in this topology`);
          }
          void s; void holder;
        },
      };
      return p;
    }
    default:
      throw new ByobError('E_CONFIG', `unknown topology ${(t as { kind: string }).kind}`);
  }
}

/** '<seat>.<kind>' pattern match with '*' wildcards. */
export function matchVisibility(patterns: string[], e: Entry): boolean {
  const key = `${e.seat}.${e.kind}`;
  return patterns.some(p => new RegExp('^' + p.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(key));
}
