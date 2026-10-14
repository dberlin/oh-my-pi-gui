import type { RpcCommand } from "./rpc-types";

/** Commands that retire pending reads/confirmations for one session origin. */
export const SESSION_CHANGING_COMMANDS: Readonly<Partial<Record<RpcCommand["type"], true>>> = {
	new_session: true,
	switch_session: true,
	branch: true,
	fork: true,
	handoff: true,
	fresh: true,
	tan: true,
	drop_session: true,
	switch_leaf: true,
	clear_context: true,
	collab_join: true,
	collab_leave: true,
};
