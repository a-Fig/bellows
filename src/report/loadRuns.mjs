import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Recursively find all .json files under dir.
 */
async function walkJsonFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkJsonFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * A parsed JSON value walks and quacks like a RunRecord if it has the
 * fields the report actually reads. Not a full schema validation — just
 * enough to reject junk files (empty, malformed, unrelated JSON) without
 * crashing the whole report.
 */
function looksLikeRunRecord(obj) {
  return (
    obj &&
    typeof obj === "object" &&
    typeof obj.id === "string" &&
    typeof obj.status === "string" &&
    obj.fingerprint &&
    typeof obj.fingerprint === "object" &&
    obj.usage &&
    typeof obj.usage === "object" &&
    Array.isArray(obj.turns)
  );
}

/**
 * Load every RunRecord found under runsDir (recursively). Tolerates junk:
 * non-JSON files are skipped by extension, malformed JSON is skipped with
 * a warning, and JSON that doesn't look like a RunRecord is skipped with a
 * warning. Never throws for a bad individual file.
 *
 * Returns { runs, skipped } where skipped is a list of { file, reason }.
 */
export async function loadRuns(runsDir) {
  const files = await walkJsonFiles(runsDir);
  const runs = [];
  const skipped = [];

  for (const file of files) {
    let text;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      skipped.push({ file, reason: `unreadable: ${err.message}` });
      continue;
    }
    if (!text.trim()) {
      skipped.push({ file, reason: "empty file" });
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      skipped.push({ file, reason: `invalid JSON: ${err.message}` });
      continue;
    }
    if (!looksLikeRunRecord(parsed)) {
      skipped.push({ file, reason: "does not look like a RunRecord" });
      continue;
    }
    parsed.__sourceFile = file;
    runs.push(parsed);
  }

  return { runs, skipped };
}

export async function dirExists(dir) {
  try {
    const s = await stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
}
