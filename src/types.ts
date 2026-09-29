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
  /**
   * Filesystem sandbox for this trial's agents. "landlock" turns it on even
   * when bench.config.json leaves it off; "off" is only accepted when the
   * config doesn't enforce "landlock" (a trial can add the sandbox, never
   * remove it). Absent => config.sandbox. See src/runner/sandbox.mjs.
   */
  sandbox?: "off" | "landlock";
  /**
   * Per-trial egress check (BenchConfig.sandboxEgress). "blocked" turns it on
   * even when bench.config.json leaves it "unchecked"; "unchecked" is only
   * accepted when the config doesn't enforce "blocked" (a trial can only
   * tighten, never loosen). Absent => config.sandboxEgress. See
   * src/runner/sandbox.mjs resolveSandboxEgress.
   */
  sandboxEgress?: "unchecked" | "blocked";
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
  /**
   * Extra env vars merged into pi's env for runs of this arm, e.g. to steer an
   * in-process conductor's env-configurable options (ACCORDION_SUMMARY_TRIGGER,
   * ...). Keys must match /^[A-Z][A-Z0-9_]{0,63}$/ and not collide with a
   * runner-controlled var (PI_CODING_AGENT_DIR, ACCORDION_HOME, PATH, HOME,
   * PI_CODING_AGENT_SESSION_DIR); at most 32 entries, values are strings
   * <=500 chars. Applied AFTER scrubPiEnv, and never scrubbed itself (it's
   * explicit, arm-authored config, not ambient inherited env). See
   * validateTrialSpec in src/runner/config.mjs.
   */
  env?: Record<string, string>;
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
  /** True when provisionRun's DeepSeek reasoning-compat patch (provision.mjs's
   *  patchDeepSeekCompat) changed >=1 model entry in this run's models.json
   *  copy — distinguishes post-surgery rows from pre-surgery rows in analysis. */
  deepseekCompat: boolean;
  /**
   * This arm's env overrides (ArmSpec.env, {} when absent). Two arms sharing a
   * conductorId are only distinguishable in reports/comparisons via this field
   * (and conductorId's sibling arm `name`, carried on the RunRecord/label) —
   * see src/runner/run.mjs where this is filled in alongside conductorId.
   */
  env: Record<string, string>;
  /**
   * Whether pi ran under the Landlock filesystem sandbox, and (since the
   * sandboxEgress feature) whether the egress canary checked for open
   * internet access. Absent on records written before the sandbox existed
   * (reports treat that as "off"). Records written before sandboxEgress
   * existed carry the plain `"off" | "landlock"` string form (no `egress`
   * key); reports treat those as `egress: "unchecked"` (see
   * src/report/grouping.mjs) — both forms are valid on disk, so keep reading
   * old runs/*.json working when changing this shape.
   */
  sandbox?: "off" | "landlock" | { mode: "off" | "landlock"; egress: "unchecked" | "blocked" };
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
  | { t: "attach"; at: number; sessionId: string; conductor: string; budget: number; protectTokens: number; protocolVersion: number }
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
  | { t: "detach"; at: number; reason: string }
  // A conductor called host.setStatus(text, metrics) — Accordion protocol v22's
  // `conductorStatus` server->client broadcast. This is the only first-class
  // channel a conductor has to narrate WHY it's doing (or not doing) something;
  // without recording it, a stalled/misbehaving conductor leaves no trace in any
  // artifact (see src/host/main-v15.ts's "conductorStatus" case, which dedupes
  // consecutive identical `text` before emitting). `rev` is the replica revision
  // in effect when the message arrived (0 if no sync has landed yet); `text` is
  // null when the conductor explicitly clears its status; `metrics` is the raw
  // wire field (the conductor's own free-form numeric/string/bool key-values),
  // absent when the message carried none.
  | { t: "status"; at: number; rev: number; text: string | null; metrics?: Record<string, number | string | boolean> }
  // Raw log of every `conductorState` broadcast (attach/detach/swap of the
  // ACTIVE conductor), trimmed to the fields useful for diagnosing a stall —
  // distinct from `attach`/`detach` above, which only fire for THIS host's own
  // attach lifecycle. A spawn-kind conductor that detaches and reattaches
  // mid-run, or a swap to a different conductor, is otherwise invisible in
  // host.jsonl. `id`/`label` are null when no conductor is active.
  | { t: "conductorState"; at: number; id: string | null; label?: string };

export interface ConductorTelemetry {
  conductorId: string;
  /**
   * Negotiated Accordion protocol version, from the "t":"attach" host event.
   * Undefined for telemetry predating this field. Lets downstream analysis tell
   * which metric scale a run's series is on (v19 folded the system prompt's
   * tokens into liveTokens; v22 made the system prompt a real WireBlock).
   */
  protocolVersion?: number;
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
  /**
   * Spend attributed to conductor LLM summary calls (compaction-naive,
   * triptych, handoff, ...). Sums two sources: any legacy host.jsonl
   * "complete" rows (foldHostTelemetry) PLUS the Accordion extension's
   * ACCORDION_COMPLETION_LOG side log (completions.jsonl, foldCompletionLog
   * in collect.mjs) — under Accordion protocol v22 the extension's own
   * runCompletion() is the ONLY place these calls are observable, since they
   * never round-trip through the host.
   */
  completeCostUsd: number;
  /** Total runCompletion() calls recorded in completions.jsonl, success + failure. */
  completeCalls: number;
  /** Of completeCalls, how many carried an "error" field (no usage was available). */
  completeErrors: number;
  /** Summed input tokens across successful completions.jsonl calls. */
  completeInputTokens: number;
  /** Summed output tokens across successful completions.jsonl calls. */
  completeOutputTokens: number;
  /** Summed cacheRead tokens across successful completions.jsonl calls. */
  completeCacheReadTokens: number;
  /** Summed cacheWrite tokens across successful completions.jsonl calls. */
  completeCacheWriteTokens: number;
  /**
   * Of the successful (non-error) completions folded into completeCostUsd,
   * how many carried `costUsd: null` (the provider reported no price for that
   * call) rather than a real number. These are silently treated as $0 in
   * completeCostUsd today (2026-09-29 Fable review, bellows #38 follow-up
   * items 3/4) — this count is what lets a caller tell "measured $0" apart
   * from "some completions' price is simply unknown", the conductor-side
   * analog of UsageTotals.costEstimated. 0 when every successful completion
   * carried a real price (or there were none).
   */
  completeCostUnknownCount: number;
  /**
   * Sorted, deduped "provider:model" tags (from completions.jsonl's own
   * `provider`/`model` fields) for the completions counted in
   * completeCostUnknownCount — lets the report name which provider(s) are
   * zero/unpriced instead of just flagging the run. Empty when
   * completeCostUnknownCount is 0. Legacy host.jsonl "complete" rows carry no
   * provider/model, so a null costUsd there is counted in
   * completeCostUnknownCount but cannot contribute a tag here.
   */
  completeCostUnknownProviders: string[];
  errors: string[];
  /** Non-error informational notes (greet/status/disconnect, "died — cleared to raw", ...). */
  infos: string[];
  /**
   * Last non-deduped `conductorStatus` text seen (host event t:"status"), or
   * null if the conductor never called host.setStatus() this run. The single
   * most useful field for "why did this run stall" at a glance in the report.
   */
  lastStatusText: string | null;
  /** Count of (deduped) t:"status" events folded — see foldHostTelemetry. */
  statusCount: number;
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
  /**
   * When true, strip vars matching /(API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|
   * CREDENTIAL|PRIVATE_?KEY|AUTH)/i (by NAME) out of pi's env before spawning
   * it, so the platform API key and friends aren't reachable from the
   * benchmarked agent's bash tool. Default false, for backward compat with
   * existing setups that rely on inherited env (e.g. a provider key pi reads
   * from env) — but true is RECOMMENDED for any bench run where the agent's
   * tool output isn't fully trusted. Arm env (ArmSpec.env) is applied AFTER
   * the scrub and is never itself scrubbed. See src/runner/envScrub.mjs.
   */
  scrubPiEnv?: boolean;
  /**
   * Var names exempted from scrubPiEnv's regex match (e.g. a provider API key
   * name pi itself needs to read from env instead of auth.json). Ignored when
   * scrubPiEnv is false/absent.
   */
  piEnvPassthrough?: string[];
  /**
   * "landlock": run pi (and everything it spawns: bash tool, python, the
   * Accordion extension, WS conductor runners) under a Landlock filesystem
   * sandbox that only reaches the run's workspace/agent/accordion-home/tmp
   * dirs plus system and runtime code — not other runs, the trial dir, this
   * run's harness logs, the bellows checkout or the rest of $HOME. Linux only;
   * a run fails fast (never runs unsandboxed) when Landlock is unavailable,
   * and a canary must pass before pi starts. Network is not restricted.
   * Default "off". See src/runner/sandbox.mjs and `bellows sandbox-check`.
   */
  sandbox?: "off" | "landlock";
  /** Extra absolute paths to grant inside the sandbox (ro = read, rx = read +
   *  execute, rw = full access), e.g. a probe venv. Ignored when sandbox is off. */
  sandboxAllow?: { ro?: string[]; rx?: string[]; rw?: string[] };
  /**
   * "blocked": the sandbox canary also verifies (does not itself enforce —
   * bellows runs unprivileged and cannot set firewall rules) that the agent
   * CANNOT reach the open internet: TCP connects to a fixed list of hosts
   * (github.com, raw.githubusercontent.com, pypi.org — see
   * DEFAULT_EGRESS_BLOCKED_HOSTS) must fail, run through the same
   * Landlock-wrapped canary process as the filesystem probes. Requires
   * `sandbox: "landlock"`. Default "unchecked" (current behavior: egress is
   * never checked). See src/runner/sandbox.mjs and TUTORIAL.md — "Verifying
   * egress is blocked".
   */
  sandboxEgress?: "unchecked" | "blocked";
  /** "host:port" entries (e.g. the model API host) the egress canary must
   *  confirm ARE reachable. Ignored when sandboxEgress is "unchecked". */
  sandboxEgressAllow?: string[];
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
