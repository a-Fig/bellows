/** Small formatting + escaping helpers shared by the renderer. */

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

export function fmtNum(n, digits = 0) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function fmtUsd(n, digits = 3) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return `$${n.toFixed(digits)}`;
}

export function fmtPct(n, digits = 0) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "–";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function fmtTs(iso) {
  if (!iso) return "–";
  try {
    return new Date(iso).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
  } catch {
    return String(iso);
  }
}
