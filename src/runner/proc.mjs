/**
 * Cross-platform process spawn helpers.
 *
 * On Windows, CLIs like `pi` and `npx` are `.cmd` shims. Node 24 refuses to run
 * a `.cmd` via spawn/execFile without `shell:true`, but `shell:true` with an
 * args array concatenates arguments unescaped (DEP0190) — which breaks paths
 * containing spaces (our run dirs live under "Claude Work Space"). We resolve
 * the shim's absolute path and, on Windows, invoke it through `cmd.exe /c` with
 * a properly quoted command line so `shell:false` spawning stays safe.
 */
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Resolve an executable/shim to an absolute path (Windows: prefer .cmd). */
export function resolveCommand(cmd) {
  if (path.isAbsolute(cmd) && fs.existsSync(cmd)) return cmd;
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const out = execSync(`${which} ${cmd}`, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (process.platform === "win32") {
      const cmdShim = lines.find((l) => l.toLowerCase().endsWith(".cmd"));
      if (cmdShim) return cmdShim;
    }
    if (lines[0]) return lines[0];
  } catch {
    /* fall through */
  }
  return cmd; // last resort — caller may still succeed via PATH
}

/** Quote a single Windows cmd.exe argument. */
function winQuote(arg) {
  const s = String(arg);
  if (s === "") return '""';
  if (!/[\s"^&|<>()%!]/.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/**
 * Spawn a command (possibly a Windows .cmd shim) safely with an args array,
 * without shell:true and without the DEP0190 warning.
 * @param {string} command
 * @param {string[]} args
 * @param {import("node:child_process").SpawnOptions} [options]
 */
export function spawnSafe(command, args, options = {}) {
  const resolved = resolveCommand(command);
  if (process.platform === "win32" && resolved.toLowerCase().endsWith(".cmd")) {
    // Run the .cmd through cmd.exe with an explicitly quoted command line.
    // With /s, cmd strips the FIRST and LAST quote chars of the line after /c —
    // a line with several quoted segments (e.g. "C:\Program Files\...\npx.cmd"
    // ... "C:\...\host.jsonl") gets mangled unless the whole line is wrapped in
    // one extra outer quote pair, which /s then strips verbatim.
    const line = [winQuote(resolved), ...args.map(winQuote)].join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
      ...options,
      shell: false,
      windowsVerbatimArguments: true,
    });
  }
  return spawn(resolved, args, { ...options, shell: false });
}
