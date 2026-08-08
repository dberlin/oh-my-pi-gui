/** Whether this dialog is the last (therefore visually topmost) dialog portal. */
export function isTopmostDialog(dialog: HTMLElement | null): boolean {
	if (!dialog) return false;
	const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"]');
	return dialogs[dialogs.length - 1] === dialog;
}
