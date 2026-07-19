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
  /**
   * Optional git rev (branch, tag, or SHA) of the accordion repo to bench. When
   * set, the runner fetches it from the accordion repo's origin and checks it out
   * into a pinned, detached worktree WITHOUT touching config.accordionRepo's
   * working tree; that worktree becomes the effective accordion repo for the run.
   * Absent => use config.accordionRepo as-is. Must match /^[A-Za-z0-9._\/-]{1,200}$/
   * and not start with "-". Example: an unmerged conductor PR branch like
   * "claude/happy-fermat-8b7485".
   */
  accordionRef?: string;
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
    /**
     * Hard total-token ceiling per run. The backstop cap when the provider
     * prices at $0 (custom models.json entries without cost rates make the
     * dollar cap inert). Strongly recommended for token-router models.
     */
    totalTokens?: number;
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
  | "completed"        // agent loop ended normally with a substantive final message; see agentFinalized/sweepFinalize in the record for platform finalization provenance
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
  /**
   * Plan round-trip aggregate (Accordion issue #58), computed over turns with
   * an rttMs sample. Null/absent when no turn in this run carries rttMs (old
   * sessions, non-accordion runs, or steering off).
   */
  planRtt?: PlanRttSummary | null;
  /** Per assistant-turn metrics parsed from the pi session JSONL. */
  turns: TurnMetric[];
  /** Telemetry from the headless host. Null for conductor "none". */
  conductor: ConductorTelemetry | null;
  /** Platform outcome pulled by label. Null if the run never finalized. */
  platform: PlatformResult | null;
  /**
   * True iff the agent itself was observed invoking a `slopcode_client`
   * `finalize` tool call (case-insensitive substring match over the tool
   * call's serialized args). False means any platform finalization for this
   * run came from the runner's own post-run sweep, not the agent — see
   * `sweepFinalize`.
   */
  agentFinalized: boolean;
  /**
   * Result of the post-run `finalizeStaleAgent` sweep: "finalized" |
   * "no-session" | "failed" | "grade-pending-gave-up", or null if the sweep
   * itself threw before returning a result.
   */
  sweepFinalize: string | null;
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
  /** True when costUsd came from config.pricing (provider reported $0). */
  costEstimated?: boolean;
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
  /**
   * Plan round-trip time in ms, stamped by the accordion extension on
   * message.usage.rttMs when the attached host declares itself armed (see
   * src/host/main.ts) (Accordion issue #58). Absent on old sessions /
   * non-accordion runs — never defaulted to 0.
   */
  rttMs?: number;
}

/** Run-level aggregate of TurnMetric.rttMs (Accordion issue #58). */
export interface PlanRttSummary {
  avgMs: number;
  maxMs: number;
  /** Count of turns with an rttMs sample (not total assistant turns). */
  turns: number;
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
  // Non-error informational note (e.g. a remote conductor's greet/status, or a
  // clean "died — cleared to raw" notice). Recorded for the report but NEVER
  // folded into RunRecord.errors — a healthy chatty remote conductor should not
  // read as error-laden. See M3/m7 in the adversarial review.
  | { t: "info"; at: number; message: string }
  // The host declared `{type:"armed"}` after hello but got no `armedAck` within
  // the watchdog window — the attached extension likely predates armed-over-wire
  // and plan waits will NOT block. Folded into ConductorTelemetry.errors so a
  // silently-degraded run surfaces loudly in the report, exactly like any other
  // integrity failure (see src/host/main.ts).
  | { t: "armed_unacked"; at: number; message: string }
  // The extension's per-`context`-hook-resolution ack (Accordion issue #60/#22, ADR 0020).
  // `cause` is one of the 5 ackable `PassthroughCause` values (`applied | empty-plan |
  // timeout-stale | timeout-raw | epoch-mismatch`) — `no-gui`/`unsent` have no reachable
  // client and are never sent over the wire. `ops`/`groups`/`recalls` are the counts
  // ACTUALLY applied to the wire for that call (0 for raw/empty causes). Accordion
  // protocol v9 removes the wire-level `recalls` field; Bellows records zero for v9+
  // to preserve this telemetry/report shape across mixed historical runs. See
  // src/host/main.ts's passthrough branch.
  | { t: "passthrough"; at: number; reqId: number; cause: string; ops: number; groups: number; recalls: number }
  // A snapshot of the extension's lifetime `/__accordion/meta` `planOutcomes` counters,
  // taken once shortly after a successful hello (`when: "start"`) and once at detach/
  // shutdown (`when: "end"`). `planOutcomes` is the raw response field (all 7 causes plus
  // `total`) or null when the endpoint was unreachable or predates Accordion PR #64/#22
  // (older extension with no `planOutcomes` field). Best-effort only — never blocks or
  // retries (see src/host/main.ts `fetchMeta`).
  | { t: "meta_snapshot"; at: number; when: "start" | "end"; planOutcomes: Record<string, number> | null }
  | { t: "detach"; at: number; reason: string };

export interface ConductorTelemetry {
  conductorId: string;
  syncs: number;
  /** Number of attach events seen; 0 means the conductor never attached. */
  attachCount: number;
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
  /** Non-error informational notes (greet/status/disconnect, "died — cleared to raw", ...). */
  infos: string[];
  /**
   * Per-cause tally of every `context` hook resolution the attached Accordion extension
   * acked during this run (Accordion issue #60/#22, ADR 0020). Preferentially the diff of
   * two `/__accordion/meta` snapshots (start-of-run vs end-of-run — the endpoint's counters
   * are lifetime totals, not per-run, so a raw end snapshot would double-count anything the
   * extension process saw before this run attached); falls back to the WS `passthrough` ack
   * tally when a meta snapshot is unavailable/unusable. `null` means the attached extension
   * never acked ANYTHING (predates Accordion PR #64/#22) — downstream MUST render this as
   * "n/a", never as 0% or 100% of calls applied.
   */
  planOutcomes: PlanOutcomes | null;
}

/**
 * Per-`PlanOutcomeCause` counts (Accordion ADR 0020). All per-cause keys are optional —
 * only causes actually observed are present — except `total` (= context-hook invocations
 * this run, across ALL 7 causes), which is always required whenever a `PlanOutcomes` value
 * exists at all.
 */
export interface PlanOutcomes {
  applied?: number;
  "empty-plan"?: number;
  "timeout-stale"?: number;
  "timeout-raw"?: number;
  "no-gui"?: number;
  "epoch-mismatch"?: number;
  unsent?: number;
  total: number;
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
  /**
   * Fallback $/Mtok rates by modelId, used when pi reports $0 cost (custom
   * providers without cost rates). Resulting costUsd is marked costEstimated.
   */
  pricing?: Record<
    string,
    { inputPerMtok?: number; outputPerMtok?: number; cacheReadPerMtok?: number; cacheWritePerMtok?: number }
  >;
  /** `bellows worker` settings. Absent = worker mode unavailable (CLI errors clearly). */
  worker?: WorkerConfig;
}

export interface WorkerConfig {
  /** Base URL of the agent-trials control-plane API (claim/heartbeat/events/complete). */
  platformUrl: string;
  /** This machine's worker name, sent on every claim/heartbeat/events/complete call. */
  name: string;
  /**
   * Capability tags advertised on claim, e.g. "in-process", "external-conductors",
   * "gpu-probe", "has-completions". Purely informational to the scheduler.
   */
  caps: string[];
  /** `git pull --ff-only` the accordionRepo before claiming (throttled to ~once/min). */
  pullBeforeClaim: boolean;
  /** Runs to execute concurrently. Only `1` is currently supported. */
  parallel: number;
  /**
   * Self-update: when idle, fast-forward THIS bellows checkout to
   * origin/main and exit(0) so the supervisor relaunches on new code. See
   * src/worker/selfUpdate.mjs. Default true when absent; the
   * `BELLOWS_NO_SELF_UPDATE=1` env var force-disables regardless of this
   * field (kill switch).
   */
  autoUpdate: boolean;
}

// ---------------------------------------------------------------------------
// Worker <-> platform control-plane wire shapes (POST /api/bench/workers/claim,
// /api/bench/runs/<id>/{heartbeat,events,complete}). See bin/bellows.mjs `worker`
// command + src/worker/*.
// ---------------------------------------------------------------------------

/** A claimed unit of work — one arm × seed of a trial, already resolved server-side. */
export interface ClaimedRun {
  id: string;
  trial: string;
  name: string;
  /** Full trial config (same shape as a parsed trial YAML), JSON. */
  config: TrialSpec;
  /** The single arm object for this run. */
  arm: ArmSpec;
  seed: number;
}

export type WorkerEventType = "run-start" | "sync" | "checkpoint" | "warn" | "status-change";

export interface WorkerEvent {
  ts: number;
  type: WorkerEventType;
  data: Record<string, unknown>;
}
