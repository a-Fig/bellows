import { esc, fmtNum, fmtUsd, fmtPct, fmtDuration, fmtTs } from "./format.mjs";
import { turnSparkline, budgetLineChart } from "./svg.mjs";
import { aggregateGroup, isAborted } from "./aggregate.mjs";
import { HARD_FIELDS, SOFT_FIELDS } from "./grouping.mjs";
import { REPORT_CSS } from "./css.mjs";

function renderFingerprintTable(fp, softWarnings) {
  const rows = [...HARD_FIELDS, ...SOFT_FIELDS, "conductorId"]
    .filter((f) => f !== "conductorId")
    .map((f) => {
      const warn = softWarnings.has(f);
      return `<tr><th>${esc(f)}</th><td>${esc(fp[f])}${warn ? ` <span class="badge badge-warn">varies</span>` : ""}</td></tr>`;
    })
    .join("");
  return `<table class="fp-table">${rows}</table>`;
}

function renderGroupTable(rows) {
  if (rows.length === 0) return `<p class="section-empty">No runs in this group.</p>`;
  const best = rows[0]?.conductorId;
  const body = rows
    .map((r) => {
      const winnerClass = r.conductorId === best ? " winner" : "";
      return `<tr class="${winnerClass}">
        <td>${esc(r.conductorId)}</td>
        <td>${fmtNum(r.runsCount)}</td>
        <td>${r.abortedCount > 0 ? `${fmtNum(r.abortedCount)} <span class="badge badge-aborted">aborted</span>` : "0"}</td>
        <td>${fmtPct(r.completionRate)}</td>
        <td>${fmtNum(r.checkpointsSolved, 1)}</td>
        <td>${fmtNum(r.checkpointsAttempted, 1)}</td>
        <td>${fmtUsd(r.costUsd)}</td>
        <td>${fmtNum(r.totalTokens)}</td>
        <td>${fmtDuration(r.wallClockS)}</td>
        <td>${fmtPct(r.cacheReadShare)}</td>
      </tr>`;
    })
    .join("");
  return `<table>
    <thead><tr>
      <th>conductor</th><th>runs</th><th>aborted</th><th>completion</th>
      <th>median checkpoints solved</th><th>median attempted</th>
      <th>median cost</th><th>median tokens</th><th>median wall clock</th><th>cache-read share</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

function renderMismatchBlock(mismatches) {
  if (mismatches.length === 0) {
    return `<div class="mismatch-block">
      <h2>Fingerprint mismatch guard</h2>
      <p class="mismatch-empty">No near-miss groups detected — every pair of comparison groups differs on more than one hard field (or shares no overlap at all).</p>
    </div>`;
  }
  const rows = mismatches
    .map((m) => {
      const aLabel = m.groupA.runs[0]?.fingerprint?.conductorId ?? m.groupA.key.slice(0, 8);
      const bLabel = m.groupB.runs[0]?.fingerprint?.conductorId ?? m.groupB.key.slice(0, 8);
      return `<div class="mismatch-row">
        Group <strong>${esc(aLabel)}</strong>-set (${m.groupA.runs.length} runs) and
        <strong>${esc(bLabel)}</strong>-set (${m.groupB.runs.length} runs) differ on exactly one field:
        <span class="mismatch-field">${esc(m.field)}</span>
        (<code>${esc(m.valueA)}</code> vs <code>${esc(m.valueB)}</code>).
        These runs are <strong>not</strong> shown in the same comparison table.
      </div>`;
    })
    .join("");
  return `<div class="mismatch-block">
    <h2>Fingerprint mismatch guard — ${mismatches.length} near-miss pair${mismatches.length === 1 ? "" : "s"}</h2>
    ${rows}
  </div>`;
}

function renderConductorTelemetry(t) {
  if (!t) return `<div class="stat-block"><div class="label">conductor</div><div class="value">none (raw baseline)</div></div>`;
  return `
    <div class="stat-block"><div class="label">conductor</div><div class="value">${esc(t.conductorId)}</div></div>
    <div class="stat-block"><div class="label">syncs / plans sent</div><div class="value">${fmtNum(t.syncs)} / ${fmtNum(t.plansSent)}</div></div>
    <div class="stat-block"><div class="label">total fold ops</div><div class="value">${fmtNum(t.totalFoldOps)}</div></div>
    <div class="stat-block"><div class="label">held-plan replies</div><div class="value">${fmtNum(t.heldPlanReplies)}</div></div>
    <div class="stat-block"><div class="label">conduct latency p50 / max</div><div class="value">${fmtNum(t.conductLatencyMs?.p50)}ms / ${fmtNum(t.conductLatencyMs?.max)}ms</div></div>
    <div class="stat-block"><div class="label">complete() spend</div><div class="value">${fmtUsd(t.completeCostUsd)}</div></div>
    ${t.errors?.length ? `<div class="stat-block"><div class="label">telemetry errors</div><div class="value">${t.errors.length}</div></div>` : ""}
  `;
}

function renderRunDetail(run) {
  const aborted = isAborted(run);
  const statusClass = `status-${run.status}`;
  const scoreText = aborted
    ? `<span class="badge badge-aborted">harness telemetry only — no platform score</span>`
    : `checkpoints ${fmtNum(run.platform.checkpointsSolved)}/${fmtNum(run.platform.checkpointsAttempted)}`;

  return `<details class="run-detail">
    <summary>
      <span class="run-id">${esc(run.id)}</span>
      <span class="${statusClass}">${esc(run.status)}</span>
      ${run.statusDetail ? `<span class="badge badge-warn">${esc(run.statusDetail)}</span>` : ""}
      <span>${scoreText}</span>
      <span>${fmtUsd(run.usage?.costUsd)}</span>
      <span>${fmtNum(run.usage?.totalTokens)} tok</span>
      <span>${fmtDuration(run.timing?.wallClockS)}</span>
    </summary>
    <div class="run-body">
      <div><strong>per-turn cost (orange) / tokens (teal)</strong></div>
      ${turnSparkline(run.turns)}

      <h3 style="margin-top:14px;">Conductor telemetry</h3>
      <div class="run-grid">${renderConductorTelemetry(run.conductor)}</div>

      ${
        run.conductor?.budgetSeries?.length
          ? `<h3 style="margin-top:14px;">Budget over time (teal = live tokens, dashed red = budget)</h3>${budgetLineChart(run.conductor.budgetSeries)}`
          : ""
      }

      <h3 style="margin-top:14px;">Artifacts</h3>
      <div class="artifact-links">
        <div>pi session: <code>${esc(run.artifacts?.piSessionFile ?? "–")}</code></div>
        <div>host telemetry: <code>${esc(run.artifacts?.hostTelemetryFile ?? "–")}</code></div>
        <div>workspace: <code>${esc(run.artifacts?.workspaceDir ?? "–")}</code></div>
        <div>agent dir: <code>${esc(run.artifacts?.agentDir ?? "–")}</code></div>
      </div>

      <h3 style="margin-top:14px;">Timing / usage</h3>
      <div class="run-grid">
        <div class="stat-block"><div class="label">started / ended</div><div class="value">${fmtTs(run.timing?.startedAt)}<br/>${fmtTs(run.timing?.endedAt)}</div></div>
        <div class="stat-block"><div class="label">assistant turns / tool calls</div><div class="value">${fmtNum(run.usage?.assistantTurns)} / ${fmtNum(run.usage?.toolCalls)}</div></div>
        <div class="stat-block"><div class="label">input / output tokens</div><div class="value">${fmtNum(run.usage?.input)} / ${fmtNum(run.usage?.output)}</div></div>
        <div class="stat-block"><div class="label">cache read / write</div><div class="value">${fmtNum(run.usage?.cacheRead)} / ${fmtNum(run.usage?.cacheWrite)}</div></div>
      </div>
    </div>
  </details>`;
}

function renderGroupSection(group, index) {
  const rows = aggregateGroup(group);
  const anchorId = `group-${index}`;
  const allRuns = [...group.runs].sort((a, b) => (a.id < b.id ? -1 : 1));
  const abortedCount = group.runs.filter(isAborted).length;

  return `<section class="group" id="${anchorId}">
    <div class="group-title">
      <h2 style="margin:0;border:none;padding:0;">Comparison group ${index + 1}</h2>
      <span class="badge badge-conductor">${rows.length} conductor${rows.length === 1 ? "" : "s"}</span>
      <span class="badge">${group.runs.length} runs</span>
      ${abortedCount > 0 ? `<span class="badge badge-aborted">${abortedCount} aborted</span>` : ""}
      ${group.softWarnings.size > 0 ? `<span class="badge badge-warn">varies: ${[...group.softWarnings].join(", ")}</span>` : ""}
    </div>

    ${renderGroupTable(rows)}

    <details class="fp-details">
      <summary>fingerprint (shared hard fields)</summary>
      ${renderFingerprintTable(group.fingerprint, group.softWarnings)}
    </details>

    <h3 style="margin-top:20px;">Per-run detail</h3>
    ${allRuns.map(renderRunDetail).join("\n")}
  </section>`;
}

function renderSkippedFiles(skipped) {
  if (skipped.length === 0) return "";
  const items = skipped.map((s) => `<div>${esc(s.file)} — ${esc(s.reason)}</div>`).join("");
  return `<details class="skipped-files">
    <summary>${skipped.length} file${skipped.length === 1 ? "" : "s"} skipped while loading runs</summary>
    ${items}
  </details>`;
}

export function renderReport({ runs, skipped, groups, mismatches, runsDir, generatedAt }) {
  const abortedTotal = runs.filter(isAborted).length;

  const toc = groups
    .map((g, i) => `<a href="#group-${i}">group ${i + 1}</a>`)
    .join("");

  const body = `
    <div class="toc">${toc || '<span class="section-empty">no comparison groups</span>'}</div>
    <h1>bellows conductor benchmark report</h1>
    <div class="meta">
      <span>generated ${esc(generatedAt)}</span>
      <span>source: <code>${esc(runsDir)}</code></span>
      <span>${runs.length} run record${runs.length === 1 ? "" : "s"} loaded</span>
      <span>${groups.length} comparison group${groups.length === 1 ? "" : "s"}</span>
      ${abortedTotal > 0 ? `<span class="badge badge-aborted">${abortedTotal} aborted (harness telemetry only)</span>` : ""}
    </div>
    ${renderSkippedFiles(skipped)}

    ${renderMismatchBlock(mismatches)}

    ${
      groups.length === 0
        ? `<p class="section-empty">No comparable runs found under ${esc(runsDir)}.</p>`
        : groups.map(renderGroupSection).join("\n")
    }

    <footer>bellows report generator — static, self-contained, no network calls.</footer>
  `;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>bellows report — ${esc(generatedAt)}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}
