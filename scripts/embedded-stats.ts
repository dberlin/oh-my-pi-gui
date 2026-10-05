import type * as Stats from "@oh-my-pi/omp-stats";
import type * as Proxy from "@oh-my-pi/pi-ai/utils/proxy";
import type * as Dirs from "@oh-my-pi/pi-utils/dirs";
import type * as WorkerHost from "@oh-my-pi/pi-utils/worker-host";
import type * as Standalone from "../../coding-agent/src/judgment/standalone";

/** GUI-only command: real upstream dashboard and judge, with no browser opener. */
export async function startEmbeddedStats(): Promise<void> {
	// Match vanilla's pre-spawn environment cleanup without loading cli.ts,
	// whose PI_COMPILED entry guard would run the GUI selector as a CLI command.
	delete process.env.MallocStackLogging;
	delete process.env.MallocStackLoggingNoCompact;
	const { setProfile, resolveProfileEnv }: typeof Dirs = require("@oh-my-pi/pi-utils/dirs.js");
	setProfile(resolveProfileEnv(process.env.OMP_PROFILE, process.env.PI_PROFILE));
	// dirs/worker-host are side-effect-free. The stats, proxy, and judge graphs
	// can read the selected profile's .env, so load them only after setProfile.
	const { declareWorkerHostEntry }: typeof WorkerHost = require("@oh-my-pi/pi-utils/worker-host.js");
	declareWorkerHostEntry();
	// Proxy installation captures PI_PROXY; load the selected profile's dotenv
	// before installing it, rather than relying on the later stats import.
	require("@oh-my-pi/pi-utils/env.js");
	const { installGlobalProxyFetch }: typeof Proxy = require("../../ai/src/utils/proxy");
	installGlobalProxyFetch();
	const { startServer, formatStatsDashboardUrl, closeDb }: typeof Stats = require("@oh-my-pi/omp-stats/index.js");
	const cwd = process.cwd();
	let standalone: Standalone.StandaloneJudge | undefined;
	const server = await startServer(0, "127.0.0.1", {
		judge: async () => {
			// Frustration owns lazy/cached judge resolution. Do not initialize
			// settings, auth, extensions, or providers just to open a dashboard.
			const { openStandaloneJudge }: typeof Standalone = require("../../coding-agent/src/judgment/standalone");
			standalone = await openStandaloneJudge(cwd, "stats_frustration");
			return standalone.judge;
		},
	});
	const shutdown = () => {
		server.stop();
		standalone?.close();
		closeDb();
		process.exit(0);
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);
	console.log(`Dashboard available at: ${formatStatsDashboardUrl(server.hostname, server.port)}`);
}
