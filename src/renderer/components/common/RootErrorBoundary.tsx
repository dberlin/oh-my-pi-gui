import { Component, type ReactNode, useEffect, useState } from "react";
import { translate } from "../../lib/i18n";

interface RootErrorBoundaryProps {
	children: ReactNode;
}

interface RootErrorBoundaryState {
	error: Error | null;
}

function RootErrorFallback({ error }: { error: Error }) {
	const [logPath, setLogPath] = useState<string | null>(null);

	useEffect(() => {
		window.omp?.runtime
			?.logPath()
			.then(setLogPath)
			.catch(() => {});
	}, []);

	return (
		<main className="flex h-full w-full items-center justify-center bg-[var(--omp-bg-primary)] px-6 text-[var(--omp-text)]">
			<section className="w-full max-w-xl rounded-2xl border border-[var(--omp-border)] bg-[var(--omp-bg-secondary)] p-6 shadow-2xl">
				<div className="mb-4 h-1 w-12 rounded-full bg-[var(--omp-error)]" />
				<h1 className="font-display text-lg font-semibold">{translate("appError.title")}</h1>
				<p className="mt-2 text-sm leading-relaxed text-[var(--omp-muted)]">{translate("appError.description")}</p>
				<pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--omp-border-muted)] bg-[var(--omp-code-bg)] p-3 font-mono text-[11px] leading-relaxed text-[var(--omp-error)]">
					{error.message}
				</pre>
				{logPath ? (
					<p className="mt-3 break-all font-mono text-[10.5px] leading-relaxed text-[var(--omp-dim)]">
						{translate("appError.logPath", { path: logPath })}
					</p>
				) : null}
				<button
					type="button"
					onClick={() => window.location.reload()}
					className="omp-pressable mt-5 rounded-lg bg-[var(--omp-accent)] px-4 py-2 text-xs font-semibold text-white hover:bg-[var(--omp-accent-bright)]"
				>
					{translate("appError.reload")}
				</button>
			</section>
		</main>
	);
}

export class RootErrorBoundary extends Component<RootErrorBoundaryProps, RootErrorBoundaryState> {
	state: RootErrorBoundaryState = { error: null };

	static getDerivedStateFromError(error: unknown): RootErrorBoundaryState {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}

	render(): ReactNode {
		return this.state.error ? <RootErrorFallback error={this.state.error} /> : this.props.children;
	}
}
