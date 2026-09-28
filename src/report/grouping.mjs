/**
 * Fingerprint-based grouping for RunRecords.
 *
 * A "comparison group" is a set of runs whose conditions are identical on
 * every HARD field — everything except which conductor was attached and a
 * handful of provenance fields that don't affect what was measured. Runs
 * that differ on any hard field must NEVER be compared in the same table;
 * that's the whole reason this module exists.
 */

// Fields that define a comparable condition. conductorId is deliberately
// excluded: different conductors under the same condition are exactly what
// a comparison group exists to compare against each other.
export const HARD_FIELDS = [
  "model",
  "budget",
  "protectTokens",
  "problems",
  "workspaceTemplateHash",
  "kickoffPromptHash",
];

// Fields that differing produces a soft warning badge on the group, but
// never splits it.
// `sandbox` ("off" | "landlock"): whether the agent ran under bellows' Landlock
// filesystem sandbox. Soft, not hard, so turning the sandbox on doesn't orphan
// every earlier record — but a group mixing both gets a visible badge.
export const SOFT_FIELDS = ["piVersion", "accordionCommit", "bellowsVersion", "sandbox"];

// Value a record implies for a field it predates (records written before the
// sandbox existed were all unsandboxed).
export const SOFT_FIELD_DEFAULTS = { sandbox: "off" };

/** A fingerprint field's value, with SOFT_FIELD_DEFAULTS applied. */
export function fpField(fp, f) {
  const v = fp?.[f];
  return v === undefined && f in SOFT_FIELD_DEFAULTS ? SOFT_FIELD_DEFAULTS[f] : v;
}

function groupKey(fp) {
  return HARD_FIELDS.map((f) => String(fp[f])).join("");
}

/**
 * Group runs by compatible (hard-field-identical) fingerprint.
 * Returns { groups, mismatches } where:
 *   groups: Array<{ key, fingerprint, runs: RunRecord[], softWarnings: Set<string> }>
 *   mismatches: near-miss pairs across different groups that differ on
 *     exactly one hard field (the dangerous almost-comparable case).
 */
export function groupRuns(runs) {
  const byKey = new Map();

  for (const run of runs) {
    const fp = run.fingerprint;
    if (!fp) continue; // tolerated elsewhere; defensive here too
    const key = groupKey(fp);
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        fingerprint: fp,
        runs: [],
        softWarnings: new Set(),
      });
    }
    const group = byKey.get(key);
    group.runs.push(run);
    for (const f of SOFT_FIELDS) {
      if (String(fpField(group.fingerprint, f)) !== String(fpField(fp, f))) {
        group.softWarnings.add(f);
      }
    }
  }

  const groups = [...byKey.values()].sort((a, b) => b.runs.length - a.runs.length);

  const mismatches = findNearMisses(groups);

  return { groups, mismatches };
}

/**
 * Find pairs of groups whose fingerprints differ on exactly one HARD field.
 * This is the failure mode the report exists to prevent: someone eyeballs
 * two tables side by side and assumes the runs are comparable when in fact
 * one field silently differs.
 */
function findNearMisses(groups) {
  const near = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i].fingerprint;
      const b = groups[j].fingerprint;
      const diffFields = HARD_FIELDS.filter((f) => String(a[f]) !== String(b[f]));
      if (diffFields.length === 1) {
        near.push({
          groupA: groups[i],
          groupB: groups[j],
          field: diffFields[0],
          valueA: a[diffFields[0]],
          valueB: b[diffFields[0]],
        });
      }
    }
  }
  return near;
}
