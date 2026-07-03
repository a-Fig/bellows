/*
 * telemetry.ts — append-only HostEvent JSONL writer.
 *
 * The host emits one `HostEvent` (src/types.ts) per line. The collector (report side)
 * folds this stream into `ConductorTelemetry`.
 *
 * Writes are SYNCHRONOUS (appendFileSync). Event volume is tiny (a handful per model
 * call), and on Windows the runner's `child.kill("SIGTERM")` is TerminateProcess —
 * signal handlers never run, so a buffered stream would lose its tail exactly when
 * telemetry matters most (a wedged host being put down). Sync appends mean a hard
 * kill can only lose the event being written, never a buffer.
 *
 * Each line is exactly one JSON object + "\n" — a record is serialized fully before
 * the append, so a torn line is the only (single-event) worst case.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { HostEvent } from "../types";

export class Telemetry {
	private closed = false;

	constructor(private file: string) {
		mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
	}

	/** Append one event synchronously. Best-effort: telemetry must never crash the host. */
	emit(ev: HostEvent): void {
		if (this.closed) return;
		try {
			appendFileSync(this.file, JSON.stringify(ev) + "\n");
		} catch {
			/* best-effort */
		}
	}

	/** Kept for interface compatibility with callers that flush on shutdown. Idempotent. */
	async close(): Promise<void> {
		this.closed = true;
	}
}
