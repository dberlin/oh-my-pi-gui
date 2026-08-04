/**
 * Model picker: grouped-by-provider dropdown with search, auth status from
 * login providers, current model highlighted. Selection calls set_model.
 */

import { Check, Cpu, Search } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import type { LoginProvider, ModelInfo } from "../../../shared/rpc-types";
import { useT } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Badge, Modal, Spinner } from "../common";

export function ModelPicker() {
	const t = useT();
	const open = useUiStore(state => state.modelPickerOpen);
	const close = useUiStore(state => state.closeModelPicker);
	const availableModels = useModelStore(state => state.availableModels);
	const current = useModelStore(state => state.model);
	const setAvailableModels = useModelStore(state => state.setAvailableModels);

	const [query, setQuery] = useState("");
	const [providers, setProviders] = useState<LoginProvider[]>([]);
	const [switching, setSwitching] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [activeIndex, setActiveIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const listboxId = useId();

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setLoading(true);
		setError(null);
		setActiveIndex(0);
		requestAnimationFrame(() => inputRef.current?.focus());
		let cancelled = false;
		void Promise.allSettled([window.omp.rpc.getLoginProviders(), window.omp.rpc.getAvailableModels()])
			.then(([providersResult, modelsResult]) => {
				if (cancelled) return;
				let gotProviders = false;
				let gotModels = false;
				if (providersResult.status === "fulfilled" && providersResult.value.success) {
					const data = providersResult.value.data as { providers?: LoginProvider[] } | undefined;
					setProviders(data?.providers ?? []);
					gotProviders = true;
				}
				if (modelsResult.status === "fulfilled" && modelsResult.value.success) {
					const data = modelsResult.value.data as { models?: ModelInfo[] } | undefined;
					setAvailableModels(data?.models ?? []);
					gotModels = true;
				}
				if (!gotProviders && !gotModels) {
					const pErr =
						providersResult.status === "rejected"
							? String(providersResult.reason)
							: !providersResult.value.success
								? providersResult.value.error
								: null;
					const mErr =
						modelsResult.status === "rejected"
							? String(modelsResult.reason)
							: !modelsResult.value.success
								? modelsResult.value.error
								: null;
					setError(pErr ?? mErr ?? t("modelPicker.notResponding"));
				}
			})
			.catch(cause => {
				if (!cancelled) setError(String(cause));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, setAvailableModels, t]);

	const authByProvider = useMemo(() => {
		const map = new Map<string, LoginProvider>();
		for (const provider of providers) map.set(provider.id, provider);
		return map;
	}, [providers]);

	const groups = useMemo(() => {
		const q = query.trim().toLowerCase();
		const filtered = availableModels.filter(
			model => q.length === 0 || model.id.toLowerCase().includes(q) || model.provider.toLowerCase().includes(q),
		);
		const map = new Map<string, typeof filtered>();
		for (const model of filtered) {
			const list = map.get(model.provider) ?? [];
			list.push(model);
			map.set(model.provider, list);
		}
		return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
	}, [availableModels, query]);

	// Flat row order (group order → in-group order) for keyboard navigation.
	const flatOptions = useMemo(
		() =>
			groups.flatMap(([provider, models]) =>
				models.map(model => ({ provider, modelId: model.id, key: `${provider}/${model.id}` })),
			),
		[groups],
	);
	const indexByKey = useMemo(() => new Map(flatOptions.map((option, index) => [option.key, index])), [flatOptions]);

	// Clamp the highlight when the visible list shrinks (search, reload).
	useEffect(() => {
		setActiveIndex(index => Math.min(index, Math.max(0, flatOptions.length - 1)));
	}, [flatOptions.length]);

	useEffect(() => {
		listRef.current?.querySelector(`[data-option-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	const select = async (provider: string, modelId: string) => {
		const key = `${provider}/${modelId}`;
		setSwitching(key);
		try {
			const response = await window.omp.rpc.setModel(provider, modelId);
			if (!response.success) {
				toast({ variant: "error", title: t("modelPicker.failed"), message: response.error });
				return;
			}
			close();
		} finally {
			setSwitching(null);
		}
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				setActiveIndex(index => Math.min(index + 1, flatOptions.length - 1));
				break;
			case "ArrowUp":
				event.preventDefault();
				setActiveIndex(index => Math.max(index - 1, 0));
				break;
			case "Home":
				event.preventDefault();
				setActiveIndex(0);
				break;
			case "End":
				event.preventDefault();
				setActiveIndex(Math.max(0, flatOptions.length - 1));
				break;
			case "Enter": {
				event.preventDefault();
				const option = flatOptions[activeIndex];
				if (option) void select(option.provider, option.modelId);
				break;
			}
		}
	};

	// role="listbox" only when option rows actually render (loading / error /
	// empty states are plain status blocks, not listbox children).
	const showOptions = !error && !loading && groups.length > 0;

	return (
		<Modal
			ariaLabel={t("modelPicker.searchLabel")}
			bodyClassName="p-0"
			chromeless
			onClose={close}
			open={open}
			placement="top"
			size="picker"
		>
			<div className="flex h-full flex-col">
				<div className="flex items-center gap-2.5 border-b border-(--omp-border-muted) px-3.5 py-2.5">
					<Search className="shrink-0 text-(--omp-dim)" size={14} />
					<input
						aria-activedescendant={flatOptions.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined}
						aria-controls={listboxId}
						aria-label={t("modelPicker.searchLabel")}
						className="min-w-0 flex-1 bg-transparent text-sm text-(--omp-text) placeholder:text-(--omp-dim) focus:outline-none"
						onChange={event => setQuery(event.target.value)}
						onKeyDown={onKeyDown}
						placeholder={t("modelPicker.placeholder")}
						ref={inputRef}
						value={query}
					/>
					<kbd className="shrink-0 rounded border border-(--omp-border-muted) bg-(--omp-bg-tertiary) px-1.5 py-0.5 text-[9px] text-(--omp-dim)">
						esc
					</kbd>
				</div>
				<div
					className="min-h-0 flex-1 overflow-y-auto p-1.5"
					id={listboxId}
					ref={listRef}
					role={showOptions ? "listbox" : undefined}
				>
					{error ? (
						<div className="flex flex-col items-center gap-3 py-10">
							<span className="text-xs text-[var(--omp-error)]">{error}</span>
							<span className="text-[10px] text-[var(--omp-dim)]">{t("modelPicker.notRespondingHint")}</span>
							<button
								type="button"
								className="rounded-md border border-[var(--omp-border-muted)] px-3 py-1 text-[11px] font-medium text-[var(--omp-text)] hover:bg-[var(--omp-selected-bg)]"
								onClick={() => {
									setError(null);
									setLoading(true);
									void Promise.allSettled([
										window.omp.rpc.getLoginProviders(),
										window.omp.rpc.getAvailableModels(),
									])
										.then(([pr, mr]) => {
											if (pr.status === "fulfilled" && pr.value.success) {
												setProviders((pr.value.data as { providers?: LoginProvider[] })?.providers ?? []);
											}
											if (mr.status === "fulfilled" && mr.value.success) {
												setAvailableModels((mr.value.data as { models?: ModelInfo[] })?.models ?? []);
											}
											if (
												(pr.status === "rejected" || !pr.value.success) &&
												(mr.status === "rejected" || !mr.value.success)
											) {
												setError(t("modelPicker.stillNotResponding"));
											}
										})
										.catch(() => setError(t("modelPicker.stillNotRespondingShort")))
										.finally(() => setLoading(false));
								}}
							>
								{t("modelPicker.retry")}
							</button>
						</div>
					) : loading ? (
						<div className="flex items-center justify-center gap-2 py-10">
							<Spinner size="sm" />
							<span className="text-xs text-(--omp-dim)">{t("modelPicker.loading")}</span>
						</div>
					) : availableModels.length === 0 ? (
						<div className="py-10 text-center text-xs text-(--omp-dim)">{t("modelPicker.empty")}</div>
					) : groups.length === 0 ? (
						<div className="py-10 text-center text-xs text-(--omp-dim)">
							{t("modelPicker.noMatch", { query })}
						</div>
					) : (
						groups.map(([provider, models]) => {
							const auth = authByProvider.get(provider);
							return (
								<section aria-label={provider} className="mb-1" key={provider} role="group">
									<div className="flex items-center gap-2 px-2.5 pt-2 pb-1">
										<Cpu className="shrink-0 text-(--omp-dim)" size={10} />
										<span className="text-[9px] font-semibold tracking-widest text-(--omp-dim) uppercase">
											{provider}
										</span>
										{auth && (
											<Badge variant={auth.authenticated ? "success" : auth.available ? "warning" : "muted"}>
												{auth.authenticated
													? t("modelPicker.auth.authenticated")
													: auth.available
														? t("modelPicker.auth.notSignedIn")
														: t("modelPicker.auth.unavailable")}
											</Badge>
										)}
										<span className="ml-auto text-[9px] tabular-nums text-(--omp-dim)">{models.length}</span>
									</div>
									{models.map(model => {
										const isCurrent = current?.provider === provider && current.id === model.id;
										const key = `${provider}/${model.id}`;
										const optionIndex = indexByKey.get(key) ?? 0;
										const isActive = optionIndex === activeIndex;
										return (
											<button
												aria-selected={isCurrent}
												className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${
													isActive ? "bg-(--omp-selected-bg)" : "hover:bg-(--omp-bg-tertiary)"
												}`}
												data-option-index={optionIndex}
												disabled={switching !== null}
												id={`${listboxId}-option-${optionIndex}`}
												key={key}
												onClick={() => void select(provider, model.id)}
												onMouseEnter={() => setActiveIndex(optionIndex)}
												role="option"
												type="button"
											>
												<span
													className={`min-w-0 flex-1 truncate font-mono text-xs ${isCurrent ? "font-semibold text-(--omp-accent)" : "text-(--omp-text)"}`}
												>
													{model.id}
												</span>
												{switching === key && <Spinner size="sm" />}
												{isCurrent && <Check className="shrink-0 text-(--omp-accent)" size={13} />}
											</button>
										);
									})}
								</section>
							);
						})
					)}
				</div>
			</div>
		</Modal>
	);
}
