/**
 * Tails ~/.omp/logs/omp.*.log files.
 * Uses fs.watch + createReadStream from last offset, with a directory
 * watcher for new-file discovery. A slow 15s poll is the safety net for
 * platforms where fs.watch is unreliable or a watcher silently detaches
 * (file replaced). Lines are batched: delivered via onLines at most every
 * 150ms instead of one callback per line. Maintains a 1000-line ring buffer.
 */
import { createReadStream, type FSWatcher, type Stats, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const RING_BUFFER_SIZE = 1000;
const FLUSH_INTERVAL_MS = 150;
const FALLBACK_POLL_MS = 15_000;

interface WatchedFile {
	path: string;
	offset: number;
	watcher: FSWatcher | null;
}

export class LogWatcher {
	#logsDir: string;
	#files = new Map<string, WatchedFile>();
	#buffer: string[] = [];
	#pending: string[] = [];
	#flushTimer: NodeJS.Timeout | null = null;
	#pollTimer: NodeJS.Timeout | null = null;
	#dirWatcher: FSWatcher | null = null;
	#running = false;

	onLines: ((lines: string[]) => void) | null = null;

	constructor(logsDir?: string) {
		this.#logsDir = logsDir ?? join(homedir(), ".omp", "logs");
	}

	start(): void {
		this.#running = true;
		void this.#discoverFiles();
		this.#watchDirectory();
		// Safety net only — fs.watch drives the hot path.
		this.#pollTimer = setInterval(() => this.#poll(), FALLBACK_POLL_MS);
	}

	stop(): void {
		this.#running = false;
		if (this.#pollTimer) {
			clearInterval(this.#pollTimer);
			this.#pollTimer = null;
		}
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = null;
		}
		this.#flush();
		this.#dirWatcher?.close();
		this.#dirWatcher = null;
		for (const file of this.#files.values()) {
			file.watcher?.close();
		}
		this.#files.clear();
		this.#buffer = [];
	}

	getBuffer(): string[] {
		return [...this.#buffer];
	}

	async #discoverFiles(): Promise<void> {
		try {
			const entries = await readdir(this.#logsDir);
			for (const entry of entries) {
				if (entry.startsWith("omp.") && entry.endsWith(".log")) {
					const fullPath = join(this.#logsDir, entry);
					if (!this.#files.has(fullPath)) {
						await this.#watchFile(fullPath);
					}
				}
			}
		} catch {
			// Directory may not exist yet
		}
	}

	/** Watch the logs directory itself so new/rotated log files are picked up. */
	#watchDirectory(): void {
		try {
			const watcher = watch(this.#logsDir, (_eventType, filename) => {
				if (!filename?.startsWith("omp.") || !filename.endsWith(".log")) return;
				const fullPath = join(this.#logsDir, filename);
				if (!this.#files.has(fullPath)) {
					void this.#watchFile(fullPath);
				}
			});
			watcher.on("error", () => {
				watcher.close();
				if (this.#dirWatcher === watcher) this.#dirWatcher = null;
			});
			this.#dirWatcher = watcher;
		} catch {
			// Logs dir may not exist yet; the fallback poll keeps discovering.
		}
	}

	async #watchFile(filePath: string): Promise<void> {
		let fileStat: Stats;
		try {
			fileStat = await stat(filePath);
		} catch {
			return;
		}

		const watched: WatchedFile = {
			path: filePath,
			offset: fileStat.size, // Start from end (only new content)
			watcher: null,
		};

		try {
			const watcher = watch(filePath, eventType => {
				if (eventType === "change") {
					this.#readNewContent(watched);
				}
			});
			watcher.on("error", () => {
				// fs.watch unreliable; the fallback poll covers this file
				watcher.close();
				watched.watcher = null;
			});
			watched.watcher = watcher;
		} catch {
			// Fall back to polling only
		}

		this.#files.set(filePath, watched);
	}

	#poll(): void {
		if (!this.#running) return;
		this.#discoverFiles();
		for (const file of this.#files.values()) {
			this.#readNewContent(file);
		}
	}

	#readNewContent(file: WatchedFile): void {
		stat(file.path)
			.then(fileStat => {
				if (fileStat.size <= file.offset) {
					// File truncated or unchanged
					if (fileStat.size < file.offset) {
						file.offset = 0;
					}
					return;
				}

				const stream = createReadStream(file.path, {
					start: file.offset,
					encoding: "utf-8",
				});

				let partial = "";
				stream.on("data", (chunk: string | Buffer) => {
					partial += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
					const lines = partial.split("\n");
					// Last element may be incomplete
					partial = lines.pop() ?? "";
					for (const line of lines) {
						if (line.trim()) {
							this.#pushLine(line);
						}
					}
				});

				stream.on("end", () => {
					if (partial.trim()) {
						this.#pushLine(partial);
					}
					file.offset = fileStat.size;
				});

				stream.on("error", () => {
					// Ignore read errors
				});
			})
			.catch(() => {
				// File may have been deleted
			});
	}

	#pushLine(line: string): void {
		this.#buffer.push(line);
		if (this.#buffer.length > RING_BUFFER_SIZE) {
			this.#buffer.shift();
		}
		this.#pending.push(line);
		if (!this.#flushTimer) {
			this.#flushTimer = setTimeout(() => this.#flush(), FLUSH_INTERVAL_MS);
		}
	}

	#flush(): void {
		if (this.#flushTimer) {
			clearTimeout(this.#flushTimer);
			this.#flushTimer = null;
		}
		if (this.#pending.length === 0) return;
		const batch = this.#pending;
		this.#pending = [];
		this.onLines?.(batch);
	}
}
