/**
 * bellows — shared contracts.
 *
 * This file is the seam between the three components:
 *   runner  (spawns pi + host per run, enforces caps, collects results)
 *   host    (headless conductor host; dials the accordion extension WS)
 *   report  (renders RunRecords to a static HTML report)
 *
 * Everything on disk (trial specs, run records, telemetry) is defined here.
 * Keep this file dependency-free.
 */

// ---------------------------------------------------------------------------
// Trial spec (trials/<name>.yaml, parsed to this shape)
// ---------------------------------------------------------------------------

export interface TrialSpec {
  /** Unique trial name. Used as the platform label prefix: `<trial>/<arm>/<seed>`. */
  trial: string;
  /**
   * What the agent is asked to do on the platform. Either a problem-set
   * preset name known to the SlopCode room (e.g. "easy-1") or an explicit
   * list of problem names. The runner passes this through to the kickoff
   * prompt; the platform room config decides what is actually available.
   */
  problems: string | string[];
  /** pi model in "provider:modelId" form, e.g. "token-router:deepseek/deepseek-v4-flash". */
  model: string;
  /** pi thinking level for all arms. Default "medium". */
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high";
  /** Accordion token budget the conductor folds down to. */
  budget: number;
  /** Protected working-tail tokens (accordion protectTokens). */
  protectTokens: number;
  arms: ArmSpec[];
  /** Repeats per arm. Default 1. */
  seeds?: number;
  caps: {
    /** Hard per-run cost ceiling in USD. Runner aborts the run at/past this. */
    costUsd: number;
    /** Max assistant turns per run. */
    turns: number;
    /** Wall-clock ceiling per run, minutes. */
    minutes: number;
  };
  /** Max runs in flight at once. Default 1. */
  parallel?: number;
  /** Where runs happen on the platform. */
  room: RoomSupply;
}

export interface ArmSpec {
  /**
   * Conductor id from Accordion's IN_PROCESS_CONDUCTORS ("builtin",
   * "cold-score", "keel", "compaction-naive", ...) or "none" for the raw
   * baseline (no host attached; context passes through untouched).
   */
  conductor: string;
  /** Optional human-readable arm name. Defaults to the conductor id. */
  name?: string;
}

export interface RoomSupply {
  /** Pre-created room ids to draw from (one concurrent run per room). */
  pool?: string[];
  /**
   * Create rooms via POST /api/rooms (API-key gated; requires the
   * agent-trials endpoint from the bellows room-create PR to be deployed).
   */
  create?: boolean;
  /** Platform base URL. Defaults to config.platformBase. */
  base?: string;
}

// ---------------------------------------------------------------------------
// Run record (runs/<trial>/<arm>-<seed>.json) — the first-class artifact.
// Comparison across trials is by fingerprint, never by trial name.
// ---------------------------------------------------------------------------

export type RunStatus =
  | "completed"        // agent finalized on the platform
  | "aborted-cost"     // cost cap hit
  | "aborted-turns"    // turn cap hit
  | "aborted-time"     // wall-clock cap hit
  | "aborted-stall"    // no activity for stallTimeoutS
  | "error";           // infrastructure failure (pi crash, WS death, ...)

export interface RunRecord {
  /** "<trial>/<arm>/<seed>" — also the platform label. */
  id: string;
  label: string;
  status: RunStatus;
  /** Set when status is error/aborted-*: what happened, for the report. */
  statusDetail?: string;
  fingerprint: Fingerprint;
  timing: { startedAt: string; endedAt: string; wallClockS: number };
  usage: UsageTotals;
  /** Per assistant-turn metrics parsed from the pi session JSONL. */
  turns: TurnMetric[];
  /** Telemetry from the headless host. Null for conductor "none". */
  conductor: ConductorTelemetry | null;
  /** Platform outcome pulled by label. Null if the run never finalized. */
  platform: PlatformResult | null;
  /** Provenance pointers for debugging. */
  artifacts: {
    piSessionFile: string;
    hostTelemetryFile: string | null;
    workspaceDir: string;
    agentDir: string;
  };
}

export interface Fingerprint {
  model: string;
  thinkingLevel: string;
  budget: number;
  protectTokens: number;
  problems: string;             // normalized (sorted, comma-joined if a list)
  workspaceTemplateHash: string; // sha256 of the workspace template contents
  kickoffPromptHash: string;     // sha256 of the rendered kickoff prompt
  piVersion: string;
  accordionCommit: string;       // git HEAD of the accordion checkout used
  conductorId: string;
  bellowsVersion: string;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  assistantTurns: number;
  toolCalls: number;
}

export interface TurnMetric {
  turnIndex: number;
  timestamp: number;            // ms epoch, from the assistant message
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  stopReason: string;
  /** Context tokens on the wire for this call, if known (from host telemetry). */
  wireTokens?: number;
}

// ---------------------------------------------------------------------------
// Host telemetry (host writes JSONL, one event per line; collector folds the
// stream into ConductorTelemetry)
// ---------------------------------------------------------------------------

export type HostEvent =
  | { t: "attach"; at: number; sessionId: string; conductor: string; budget: number; protectTokens: number }
  | { t: "sync"; at: number; rev: number; blocks: number; liveTokens: number; foldedBlocks: number }
  | { t: "conduct"; at: number; rev: number; latencyMs: number; commands: number; heldLastPlan: boolean }
  | { t: "plan"; at: number; rev: number; ops: number; groups: number }
  | { t: "complete"; at: number; costUsd: number | null; latencyMs: number }  // host.complete() relay use
  | { t: "error"; at: number; message: string }
  | { t: "detach"; at: number; reason: string };

export interface ConductorTelemetry {
  conductorId: string;
  syncs: number;
  plansSent: number;
  totalFoldOps: number;
  /** liveTokens samples over time: [atMs, liveTokens, budget]. */
  budgetSeries: Array<[number, number, number]>;
  conductLatencyMs: { p50: number; max: number };
  /** Times the 250ms window forced the previously-computed plan. */
  heldPlanReplies: number;
  /** Spend attributed to host.complete() calls (LLM conductors). */
  completeCostUsd: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Platform result (pulled from GET /games/slopcode/leaderboard?label=...)
// ---------------------------------------------------------------------------

export interface PlatformResult {
  gameId: string;
  roomId: string;
  agentName: string;
  runScore: number | null;
  checkpointsSolved: number;
  checkpointsAttempted: number;
  raw: unknown;                 // full leaderboard row for the report
}

// ---------------------------------------------------------------------------
// Bench config (bench.config.json, machine-local; see bench.config.example.json)
// ---------------------------------------------------------------------------

export interface BenchConfig {
  /** Absolute path to a local Accordion checkout (provides conductors + engine). */
  accordionRepo: string;
  /** Platform base URL. */
  platformBase: string;
  /**
   * Where the platform API key comes from: an env var name. Never store the
   * key itself in config — this repo may become public.
   */
  platformApiKeyEnv: string;
  /** pi agent dir to copy auth.json/models.json from. Default: ~/.pi/agent. */
  piAgentDir?: string;
  /** Output root for run records + artifacts. Default: ./runs. */
  runsDir?: string;
}
