// BYOB Table Protocol v0.1 — shared types. See SPEC.md.
export const PROTOCOL = 'byob/0.1' as const;

export type Kind =
  | 'system' | 'say' | 'pass' | 'raise_hand' | 'proposal' | 'decision'
  | 'approval' | 'rejection' | 'status' | 'receipt' | 'verify';

export interface Effect { owner: string; resource: string; action: string; args?: Record<string, unknown> }

export interface Capability { resource: string; actions: string[]; requires_approval?: boolean; auto_approve?: boolean }
export interface CapabilityCard { bot: string; description?: string; proxy?: boolean; capabilities: Capability[] }

export interface Entry {
  seq: number;
  table: string;
  seat: string;
  kind: Kind;
  event?: string;
  to?: string[];
  reply_to?: number;
  body?: string;
  truncated?: boolean;
  effects?: Effect[];
  refs?: string[];
  task?: string;
  state?: string;
  result?: 'pass' | 'fail';
  artifact?: unknown;
  data?: Record<string, unknown>;
  budget?: { tokens_used?: number };
  ts?: string;
}

export type PostKind = 'say' | 'pass' | 'raise_hand' | 'proposal' | 'decision' | 'status' | 'receipt' | 'verify';
export interface PostRequest {
  kind: PostKind;
  to?: string[];
  reply_to?: number;
  body?: string;
  effects?: Effect[];
  refs?: string[];
  task?: string;
  state?: 'running' | 'failed';
  result?: 'pass' | 'fail';
  artifact?: unknown;
  budget?: { tokens_used?: number };
}

export interface JoinRequest {
  protocol: typeof PROTOCOL;
  seat: string;
  owner: string;
  kind: 'bot' | 'human';
  role?: string;
  transport?: 'native' | 'http' | 'mcp' | 'cli' | 'proxy';
  card: CapabilityCard;
  nonce: string;
  signature: string;
}

export interface OwnerDecision {
  owner: string; task: string; decision: 'approve' | 'reject'; reason?: string; nonce: string; signature: string;
}

export type TerminationCond = 'decision' | 'rounds_exhausted' | 'depth_exhausted' | { budget_tokens: number } | { max_entries: number };

export interface Topology {
  kind: 'broadcast' | 'hub_spoke' | 'pipeline' | 'debate' | 'delegation';
  order?: string[];
  rounds?: number;
  pro?: string; con?: string; judge?: string;
  hub?: string;
  stages?: string[];
  reports?: Record<string, string[]>;
}

export interface TableConfig {
  id: string;
  topic: string;
  parent?: string;
  owners: Record<string, { public_key: string }>;
  topology: Topology;
  visibility?: Record<string, string[]>;
  floor?: { max_chars?: number; max_bot_depth?: number; decision_by?: string[] };
  termination: { any: TerminationCond[] };
  projection?: { inline_limit?: number };
  watchdog?: { heartbeat_ms?: number };
}

export interface Seat {
  seat: string; owner: string; kind: 'bot' | 'human'; role?: string; transport?: string; card: CapabilityCard; joined_seq: number;
}

export type TaskState = 'awaiting_approval' | 'approved' | 'running' | 'reported' | 'verified' | 'rejected' | 'failed' | 'stalled';
export interface Task {
  id: string; opened_seq: number; proposer: string; owner: string; effects: Effect[];
  state: TaskState; executor: string | null; receipt_seq?: number; last_progress_ms: number;
}

export interface Projection {
  protocol: typeof PROTOCOL;
  table: string;
  seat: string;
  prefix: { topic: string; rules: Record<string, unknown>; seats: unknown[]; decisions: { seq: number; seat: string; body?: string }[] };
  prefix_hash: string;
  tail: Entry[];
  cursor: number;
  floor: { holder: string | null; you_have_floor: boolean; grant_seq: number | null; max_chars: number };
  status: 'open' | 'closed';
  my_tasks: Task[];
}

export const ERRORS = {
  E_SCHEMA: 400,
  E_PROTOCOL: 400,
  E_BAD_SIGNATURE: 401,
  E_UNAUTHORIZED: 401,
  E_NOT_OWNER: 403,
  E_NOT_FLOOR: 409,
  E_ADDRESS: 422,
  E_NO_EXECUTOR: 422,
  E_MIXED_OWNERS: 422,
  E_NOT_DECIDER: 403,
  E_TASK_STATE: 409,
  E_SELF_VERIFY: 403,
  E_TABLE_CLOSED: 409,
  E_SEAT_TAKEN: 409,
  E_REPLAY: 409,
  E_NOT_FOUND: 404,
  E_NO_TERMINATION: 422,
  E_CONFIG: 422,
  E_DISCLOSURE: 451, // raised client-side by the seat SDK, never by the table
  E_INTERNAL: 500,
} as const;
export type ErrorCode = keyof typeof ERRORS;

const CJK = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g;
/** Token estimate for a post that reports no `budget.tokens_used` (SPEC §8): one per CJK character, one per four other characters. */
export function estimateTokens(text: string | undefined): number {
  const s = text ?? '';
  const cjk = s.match(CJK)?.length ?? 0;
  return cjk + Math.ceil((s.length - cjk) / 4);
}

export class ByobError extends Error {
  constructor(public code: ErrorCode, message: string) { super(`${code}: ${message}`); }
  get status() { return ERRORS[this.code]; }
}
