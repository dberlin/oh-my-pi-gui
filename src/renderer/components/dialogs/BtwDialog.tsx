import { GitBranch, MessageCircleQuestion } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { BtwConversation, type BtwConversationState, latestBtwTurn } from "../../lib/btw-conversation";
import { copyText } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { MarkdownRenderer } from "../../lib/markdown";
import { type SessionStore, useSessionStore } from "../../stores/session";
import {
	sessionRuntime,
	sessionRuntimeStore,
	useRuntimeTabId,
	useTabCommand,
} from "../../stores/session-runtime-context";
import { toast } from "../../stores/toast";
import { useUiStore } from "../../stores/ui";
import { Button, Modal, Spinner, TextArea } from "../common";

const EMPTY_ANSWER: BtwConversationState = {
	record: null,
	answer: "",
	loading: false,
	cancelling: false,
	error: null,
};

export function BtwDialog() {
	const t = useT();
	const command = useTabCommand();
	const tabId = useRuntimeTabId();
	const originSessionId = useSessionStore(state => state.sessionId);
	const generation = useRef(0);
	const conversation = useRef<BtwConversation | null>(null);
	const [draft, setDraft] = useState("");
	const question = useUiStore(state => state.btwRequest);
	const close = useUiStore(state => state.closeBtw);
	const [state, setState] = useState(EMPTY_ANSWER);
	const [branching, setBranching] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a dialog generation follows its opening question and originating session, not the current draft.
	useEffect(() => {
		const version = ++generation.current;
		const runtime = sessionRuntime(tabId);
		const originCommand = runtime?.command ?? command;
		const commandGeneration = runtime?.commandGeneration;
		const isCurrent = (): boolean =>
			generation.current === version &&
			(!tabId || sessionRuntime(tabId) === runtime) &&
			runtime?.commandGeneration === commandGeneration &&
			(tabId
				? (sessionRuntimeStore<SessionStore>(tabId, "session")?.getState().sessionId ?? originSessionId)
				: useSessionStore.getState().sessionId) === originSessionId;
		const owner = new BtwConversation(originCommand, isCurrent, setState);
		conversation.current = owner;
		setState(EMPTY_ANSWER);
		setBranching(false);
		setDraft(question ?? "");
		const subscribe = window.omp.events?.onTabBtwFrame;
		const unsubscribe =
			question !== null && typeof subscribe === "function"
				? subscribe((frame, frameTabId) => {
						if (frameTabId === (tabId ?? "")) owner.frame(frame);
					})
				: undefined;
		return () => {
			unsubscribe?.();
			// Cancel before retiring this generation: the captured command must
			// never address the tab's replacement session.
			void owner.close().catch(cause => {
				toast({ variant: "error", message: String(cause) });
			});
			generation.current++;
			if (conversation.current === owner) conversation.current = null;
		};
	}, [question, command, tabId, originSessionId]);

	const latest = state.record ? latestBtwTurn(state.record) : null;
	const running = latest?.status === "running";
	const busy = state.loading || running;
	const canBranch = latest?.status === "complete" && !state.loading;
	const ask = async (): Promise<void> => {
		if (typeof window.omp.events?.onTabBtwFrame !== "function") {
			setState(current => ({ ...current, error: t("btw.streamingUnsupported") }));
			return;
		}
		await conversation.current?.ask(draft);
	};

	const copyAnswer = async (): Promise<void> => {
		if (!state.answer.trim()) return;
		if (!(await copyText(state.answer))) {
			toast({ variant: "error", message: t("btw.copyFailed") });
			return;
		}
		toast({ variant: "success", message: t("btw.copied") });
	};

	const branch = async (): Promise<void> => {
		if (!canBranch || branching) return;
		const version = generation.current;
		const originCommand = sessionRuntime(tabId)?.command ?? command;
		setBranching(true);
		try {
			const response = await originCommand({ type: "btw_branch" });
			if (version !== generation.current) return;
			if (!response.success) throw new Error(response.error);
			// No vanilla RPC can promote an answer. Never treat a legacy or
			// accidental successful acknowledgement as a persisted branch.
			throw new Error(t("btw.unsupported"));
		} catch (cause) {
			if (version === generation.current)
				toast({ variant: "error", title: t("btw.branchFailed"), message: String(cause) });
		} finally {
			if (version === generation.current) setBranching(false);
		}
	};

	return (
		<Modal onClose={close} open={question !== null} size="lg" title={t("btw.title")}>
			<div className="mb-4 flex items-start gap-2 rounded-lg border border-(--omp-border-muted) bg-transparent px-3 py-2.5 text-xs text-(--omp-dim)">
				<MessageCircleQuestion className="mt-0.5 shrink-0" size={14} />
				<TextArea
					aria-label={t("btw.title")}
					value={draft}
					onChange={event => setDraft(event.target.value)}
					disabled={busy || branching}
					rows={3}
				/>
			</div>
			{state.error ? (
				<div className="mb-2 rounded-lg border border-[color-mix(in_srgb,var(--omp-error)_35%,transparent)] bg-transparent p-3 text-sm text-[var(--omp-error)]">
					{state.error}
				</div>
			) : null}
			{state.record ? (
				<div className="max-h-[55vh] overflow-y-auto pr-1">
					{(state.record.followUps?.length ?? 0) > 0 && latest ? (
						<div className="mb-2 text-xs text-(--omp-dim)">{latest.question}</div>
					) : null}
					{latest && latest.status !== "running" && latest.status !== "complete" ? (
						<div className="mb-2 text-xs text-(--omp-dim)">
							{latest.status === "cancelled" || latest.status === "interrupted"
								? t("btw.statusCancelled")
								: latest.error || t("btw.statusError")}
						</div>
					) : null}
					{state.answer ? (
						<MarkdownRenderer content={state.answer} />
					) : busy ? (
						<div className="flex items-center gap-2 py-8 text-sm text-(--omp-dim)">
							<Spinner size="sm" /> {t("btw.thinking")}
						</div>
					) : null}
				</div>
			) : state.loading ? (
				<div className="flex items-center justify-center gap-2 py-16 text-sm text-(--omp-dim)">
					<Spinner size="sm" /> {t("btw.thinking")}
				</div>
			) : null}
			<div className="mt-5 flex justify-end gap-2 border-t border-(--omp-border-muted) pt-3">
				{busy ? (
					<Button
						disabled={state.cancelling}
						onClick={() => void conversation.current?.cancel()}
						size="sm"
						variant="secondary"
					>
						{t("btw.cancel")}
					</Button>
				) : (
					<Button disabled={!draft.trim() || branching} onClick={() => void ask()} size="sm">
						{t("btw.ask")}
					</Button>
				)}
				<Button
					disabled={!state.answer.trim() || state.loading}
					onClick={() => void copyAnswer()}
					size="sm"
					variant="secondary"
				>
					{t("btw.copy")}
				</Button>
				<Button disabled={!canBranch || branching} onClick={() => void branch()} size="sm">
					{branching ? <Spinner size="sm" /> : <GitBranch size={13} />}
					{t("btw.branch")}
				</Button>
			</div>
		</Modal>
	);
}
