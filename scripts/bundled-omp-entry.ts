#!/usr/bin/env bun
import type * as VanillaCli from "../../coding-agent/src/cli";
import type * as EmbeddedStats from "./embedded-stats";
import { GUI_STATS_SELECTOR } from "../src/shared/bundled-runtime";

if (process.argv[2] === GUI_STATS_SELECTOR) {
	// PI_COMPILED makes vanilla cli.ts auto-run even when imported. Keep that
	// module entirely unevaluated for the GUI-only server selector.
	const { startEmbeddedStats }: typeof EmbeddedStats = require("./embedded-stats");
	startEmbeddedStats().catch(error => {
		console.error(error);
		process.exitCode = 1;
	});
} else {
	// No await may precede this bridge: vanilla worker dispatch installs its
	// buffering inbox in the synchronous prefix, before Bun flushes messages.
	// Compiled entries auto-run through PI_COMPILED; worker threads auto-run
	// through !Bun.isMainThread. Every selector stays owned by upstream.
	const cli: typeof VanillaCli = require("../../coding-agent/src/cli");
	if (process.env.PI_COMPILED !== "true" && Bun.isMainThread) {
		// Also support running this GUI entry directly from source. In that case
		// cli.ts is an importer, not Bun.main, and does not auto-run or declare a host.
		const { declareWorkerHostEntry } = require("@oh-my-pi/pi-utils/worker-host.js");
		declareWorkerHostEntry();
		cli.runCli(process.argv.slice(2)).catch(error => {
			console.error(error);
			process.exitCode = 1;
		});
	}
}
