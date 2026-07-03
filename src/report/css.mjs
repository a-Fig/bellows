export const REPORT_CSS = `
:root {
  --bg: #0a0a0a;
  --panel: #141414;
  --panel-alt: #1c1c1c;
  --border: #2a2a2a;
  --text: #d8d8d8;
  --text-dim: #8a8a8a;
  --text-bright: #f4f4f4;
  --accent: #21d4c1;
  --warn: #e19c7d;
  --warn-strong: #ff6b4a;
  --ok: #6fcf97;
  --user: #044eff;
  --mono: "IBM Plex Mono", "Consolas", "SFMono-Regular", Menlo, monospace;
  --sans: "IBM Plex Sans", "Segoe UI", sans-serif;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  background: var(--bg); color: var(--text);
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.5;
}
body { padding: 24px 28px 80px; max-width: 1400px; margin: 0 auto; }
h1, h2, h3 { font-family: var(--sans); color: var(--text-bright); font-weight: 600; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 32px 0 10px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
h3 { font-size: 13px; margin: 0 0 8px; color: var(--text); }
.meta { color: var(--text-dim); font-size: 12px; margin-bottom: 20px; }
.meta span { margin-right: 16px; }
a { color: var(--accent); }
table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
th, td { padding: 5px 10px; text-align: right; border-bottom: 1px solid var(--border); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { color: var(--text-dim); font-weight: 500; font-family: var(--sans); font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
tr:hover td { background: var(--panel-alt); }
tr.winner td:first-child { color: var(--ok); font-weight: 600; }
tr.winner td:first-child::before { content: "\\2605  "; }
.badge {
  display: inline-block; font-size: 10px; font-family: var(--sans);
  padding: 1px 6px; border-radius: 3px; margin-left: 6px; vertical-align: middle;
  border: 1px solid currentColor;
}
.badge-warn { color: var(--warn); }
.badge-aborted { color: var(--warn-strong); }
.badge-conductor { color: var(--accent); }
.group {
  background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
  padding: 16px 18px; margin-bottom: 20px;
}
.group-title { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.fp-table { margin-top: 10px; font-size: 11.5px; }
.fp-table td, .fp-table th { padding: 2px 8px; border: none; }
.fp-table th { text-align: left; color: var(--text-dim); width: 180px; }
.fp-table td { text-align: left; color: var(--text); }
details.fp-details { margin-top: 8px; }
details.fp-details summary { cursor: pointer; color: var(--text-dim); font-size: 11px; }

.mismatch-block {
  background: #241512; border: 1px solid var(--warn-strong); border-radius: 6px;
  padding: 14px 18px; margin-bottom: 20px;
}
.mismatch-block h2 { border: none; color: var(--warn-strong); margin-top: 0; }
.mismatch-row { padding: 6px 0; border-bottom: 1px dashed #3a2620; font-size: 12px; }
.mismatch-row:last-child { border-bottom: none; }
.mismatch-field { color: var(--warn-strong); font-weight: 600; }
.mismatch-empty { color: var(--text-dim); font-size: 12px; }

.run-detail {
  border: 1px solid var(--border); border-radius: 4px; margin: 6px 0;
  background: var(--panel-alt);
}
.run-detail summary {
  cursor: pointer; padding: 8px 12px; font-size: 12px;
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
}
.run-detail summary .run-id { color: var(--text-bright); font-weight: 600; }
.status-completed { color: var(--ok); }
.status-error, .status-aborted-cost, .status-aborted-turns, .status-aborted-time, .status-aborted-stall {
  color: var(--warn); }
.run-body { padding: 10px 14px 16px; border-top: 1px solid var(--border); }
.run-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin-top: 10px; }
.stat-block { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; }
.stat-block .label { color: var(--text-dim); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 4px; }
.stat-block .value { color: var(--text-bright); font-size: 14px; }
.artifact-links { font-size: 11.5px; color: var(--text-dim); word-break: break-all; }
.artifact-links div { margin: 2px 0; }

.spark { display: block; }
.spark-cost { stroke: var(--warn); stroke-width: 1.4; }
.spark-tokens { stroke: var(--accent); stroke-width: 1; opacity: 0.7; }
.spark-empty { fill: var(--text-dim); font-size: 10px; }
.budgetchart { display: block; }
.chart-live { stroke: var(--accent); stroke-width: 1.4; }
.chart-budget { stroke: var(--warn-strong); stroke-width: 1; stroke-dasharray: 3 2; opacity: 0.8; }
.legend { font-size: 10.5px; color: var(--text-dim); margin-top: 2px; }
.legend .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 3px; vertical-align: middle; }

.section-empty { color: var(--text-dim); font-style: italic; padding: 10px 0; }
.skipped-files { color: var(--text-dim); font-size: 11px; margin-top: 6px; }
.skipped-files summary { cursor: pointer; }

.toc { position: sticky; top: 0; background: var(--bg); padding: 10px 0; margin-bottom: 8px; border-bottom: 1px solid var(--border); z-index: 5; }
.toc a { margin-right: 14px; font-size: 12px; color: var(--text-dim); font-family: var(--sans); }
.toc a:hover { color: var(--accent); }
footer { color: var(--text-dim); font-size: 11px; margin-top: 40px; border-top: 1px solid var(--border); padding-top: 10px; }
`;
