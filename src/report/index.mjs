import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadRuns, dirExists } from "./loadRuns.mjs";
import { groupRuns } from "./grouping.mjs";
import { renderReport } from "./render.mjs";

/**
 * Render all RunRecords found under runsDir into one self-contained static
 * HTML report at outFile.
 *
 * @param {string} runsDir - directory to recursively scan for runs/**\/*.json
 * @param {string} outFile - path to write the rendered report.html to
 * @returns {Promise<void>}
 */
export default async function generateReport(runsDir, outFile) {
  const exists = await dirExists(runsDir);
  const { runs, skipped } = exists ? await loadRuns(runsDir) : { runs: [], skipped: [] };

  const { groups, mismatches } = groupRuns(runs);

  const html = renderReport({
    runs,
    skipped,
    groups,
    mismatches,
    runsDir,
    generatedAt: new Date().toISOString(),
  });

  const outDir = path.dirname(outFile);
  if (outDir && outDir !== ".") {
    await mkdir(outDir, { recursive: true });
  }
  await writeFile(outFile, html, "utf8");
}
