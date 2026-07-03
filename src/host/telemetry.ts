/*
 * telemetry.ts — append-only HostEvent JSONL writer.
 *
 * The host emits one `HostEvent` (src/types.ts) per line. The collector (report side)
 * folds this stream into `ConductorTelemetry`. We keep writes buffered and flush on a
 * short cadence AND on demand (SIGTERM / detach / process exit) so a killed run still
 * leaves a well-formed, complete-as-of-last-event file.
 *
 * Each line is exactly one JSON object + "\n". We never write a partial line: a record
 * is serialized fully before it is appended to the buffer, so a crash between flushes
 * loses only whole trailing records, never a torn one.
 */
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import path from "node:path";
import type { HostEvent } from "../types";

export class Telemetry {
	private stream: WriteStream;
	private closed = false;

	constructor(private file: string) {
		mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
		// `flags: "a"` — append; a re-run against the same path never truncates prior data.
		this.stream = createWriteStream(file, { flags: "a" });
	}

	/** Append one event. Serialized fully before write, so a line is never torn. */
	emit(ev: HostEvent): void {
		if (this.closed) return;
		try {
			this.stream.write(JSON.stringify(ev) + "\n");
		} catch {
			/* best-effort telemetry must never crash the host */
		}
	}

	/** Flush + close the stream, resolving once the OS buffer is drained. Idempotent. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await new Promise<void>((resolve) => {
			this.stream.end(() => resolve());
		});
	}
}
