/**
 * Tiny dependency-free inline SVG chart helpers. No libraries, no CDN —
 * just string templates producing <svg> markup safe to inline in the report.
 */

function scaleLinear(domainMin, domainMax, rangeMin, rangeMax) {
  const span = domainMax - domainMin;
  if (span === 0) return () => (rangeMin + rangeMax) / 2;
  return (v) => rangeMin + ((v - domainMin) / span) * (rangeMax - rangeMin);
}

/**
 * Per-turn cost/token sparkline: two overlaid polylines (cost, tokens),
 * independently normalized to the plot height so both are visible
 * regardless of scale differences.
 */
export function turnSparkline(turns, { width = 320, height = 48 } = {}) {
  if (!turns || turns.length === 0) {
    return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><text x="4" y="${height / 2}" class="spark-empty">no turns</text></svg>`;
  }
  const pad = 3;
  const xs = scaleLinear(0, Math.max(1, turns.length - 1), pad, width - pad);

  const costs = turns.map((t) => t.costUsd ?? 0);
  const tokens = turns.map((t) => (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0));

  const costY = scaleLinear(0, Math.max(...costs, 1e-9), height - pad, pad);
  const tokY = scaleLinear(0, Math.max(...tokens, 1), height - pad, pad);

  const costPts = costs.map((c, i) => `${xs(i).toFixed(1)},${costY(c).toFixed(1)}`).join(" ");
  const tokPts = tokens.map((t, i) => `${xs(i).toFixed(1)},${tokY(t).toFixed(1)}`).join(" ");

  return (
    `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `role="img" aria-label="per-turn cost and token sparkline">` +
    `<polyline points="${tokPts}" class="spark-tokens" fill="none" />` +
    `<polyline points="${costPts}" class="spark-cost" fill="none" />` +
    `</svg>`
  );
}

/**
 * budgetSeries line chart: liveTokens vs budget over time.
 * series: Array<[atMs, liveTokens, budget]>
 */
export function budgetLineChart(series, { width = 480, height = 90 } = {}) {
  if (!series || series.length === 0) {
    return `<svg class="budgetchart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><text x="4" y="${height / 2}" class="spark-empty">no budget samples</text></svg>`;
  }
  const pad = 4;
  const t0 = series[0][0];
  const t1 = series[series.length - 1][0];
  const xs = scaleLinear(t0, Math.max(t1, t0 + 1), pad, width - pad);

  const maxY = Math.max(...series.map((s) => Math.max(s[1], s[2])), 1);
  const ys = scaleLinear(0, maxY, height - pad, pad);

  const livePts = series.map((s) => `${xs(s[0]).toFixed(1)},${ys(s[1]).toFixed(1)}`).join(" ");
  const budgetPts = series.map((s) => `${xs(s[0]).toFixed(1)},${ys(s[2]).toFixed(1)}`).join(" ");

  return (
    `<svg class="budgetchart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" ` +
    `role="img" aria-label="live tokens vs budget over time">` +
    `<polyline points="${budgetPts}" class="chart-budget" fill="none" />` +
    `<polyline points="${livePts}" class="chart-live" fill="none" />` +
    `</svg>`
  );
}
