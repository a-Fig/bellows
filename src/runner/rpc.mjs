/**
 * Minimal pi RPC client over stdin/stdout.
 *
 * Line protocol (verified from pi dist modes/rpc/rpc-mode.js + jsonl.js):
 *   - Commands: one JSON object per line on stdin, LF-terminated. Optional `id`
 *     for correlation. e.g. {"type":"prompt","message":"..."} , {"type":"abort"},
 *     {"type":"get_session_stats","id":"s1"}.
 *   - Output: one JSON object per line on stdout, LF-framed (\r tolerated).
 *     Responses:  {"type":"response","command":"...","success":true,"data":...}
 *                 {"type":"response","command":"...","success":false,"error":"..."}
 *     Events:     AgentSessionEvent objects (type:"agent_end", "message", etc.)
 *     UI requests:{"type":"extension_ui_request", id, method, ...}  -> we auto-reply.
 *
 * get_session_stats.data = SessionStats { cost:number, tokens:{...}, ... }.
 */
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { spawnSafe } from "./proc.mjs";

/**
 * Wraps a spawned pi --mode rpc child. Emits:
 *   "event"    (obj)  — any non-response, non-ui stdout line (AgentSessionEvent)
 *   "response" (obj)  — a response line
 *   "line"     (obj)  — every parsed stdout object
 *   "exit"     ({code,signal})
 *   "stderr"   (string)
 */
export class PiRpc extends EventEmitter {
  /**
   * @param {object} args
   * @param {string} args.piCommand   e.g. "pi"
   * @param {string} args.cwd         workspace dir
   * @param {Record<string,string>} args.env
   * @param {string[]} [args.extraArgs]
   */
  constructor({ piCommand, cwd, env, extraArgs = [] }) {
    super();
    this.piCommand = piCommand;
    this.cwd = cwd;
    this.env = env;
    this.extraArgs = extraArgs;
    this.child = null;
    this._buf = "";
    /** @type {Map<string,{resolve:Function,reject:Function}>} */
    this._pending = new Map();
    this.exited = false;
    this.exitInfo = null;
  }

  start() {
    const args = ["--mode", "rpc", ...this.extraArgs];
    this.child = spawnSafe(this.piCommand, args, {
      cwd: this.cwd,
      env: this.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this._onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => this.emit("stderr", chunk));
    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      for (const { reject } of this._pending.values()) reject(new Error("pi exited before response"));
      this._pending.clear();
      this.emit("exit", { code, signal });
    });
    this.child.on("error", (err) => this.emit("stderr", `spawn error: ${err.message}`));
    return this;
  }

  _onStdout(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf("\n")) !== -1) {
      let line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // non-JSON stdout noise
      }
      this._dispatch(obj);
    }
  }

  _dispatch(obj) {
    this.emit("line", obj);
    if (obj && obj.type === "response") {
      if (obj.id && this._pending.has(obj.id)) {
        const { resolve } = this._pending.get(obj.id);
        this._pending.delete(obj.id);
        resolve(obj);
      }
      this.emit("response", obj);
      return;
    }
    if (obj && obj.type === "extension_ui_request") {
      this._autoReplyUi(obj);
      return;
    }
    this.emit("event", obj);
  }

  /** Auto-decline/ack extension UI prompts so a headless run never blocks. */
  _autoReplyUi(req) {
    const id = req.id;
    if (!id) return;
    // notify/setStatus/setWidget/setTitle/set_editor_text are fire-and-forget.
    const fireAndForget = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
    if (fireAndForget.has(req.method)) return;
    let response;
    if (req.method === "confirm") response = { type: "extension_ui_response", id, confirmed: true };
    else response = { type: "extension_ui_response", id, cancelled: true };
    this._write(response);
  }

  _write(obj) {
    if (!this.child || this.exited) return;
    try {
      this.child.stdin.write(JSON.stringify(obj) + "\n");
    } catch {
      /* stdin may be closed */
    }
  }

  /** Fire a command with no wait for a correlated response. */
  send(command) {
    this._write(command);
  }

  /**
   * Send a command and await its correlated response (by id). Rejects on timeout.
   * @param {object} command
   * @param {number} [timeoutMs]
   */
  request(command, timeoutMs = 30_000) {
    const id = command.id || crypto.randomUUID();
    const withId = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`RPC ${command.type} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this._pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this._write(withId);
    });
  }

  /** get_session_stats -> SessionStats data (or null on error). */
  async getSessionStats(timeoutMs = 15_000) {
    try {
      const res = await this.request({ type: "get_session_stats" }, timeoutMs);
      return res && res.success ? res.data : null;
    } catch {
      return null;
    }
  }

  async abort() {
    try {
      await this.request({ type: "abort" }, 10_000);
    } catch {
      /* ignore */
    }
  }

  /** Graceful shutdown: close stdin (triggers pi's onInputEnd shutdown), then
   *  SIGTERM after a grace period, then SIGKILL. */
  async close(graceMs = 8_000) {
    if (this.exited || !this.child) return;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    const exited = await this._waitExit(graceMs);
    if (exited) return;
    try {
      this.child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    if (await this._waitExit(4_000)) return;
    try {
      this.child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    await this._waitExit(2_000);
  }

  _waitExit(ms) {
    if (this.exited) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.exited), ms);
      this.once("exit", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
