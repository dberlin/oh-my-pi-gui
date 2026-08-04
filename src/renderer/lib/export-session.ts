/**
 * Native "Export HTML" flow shared by the app menu handler and the command
 * registry: save-dialog → rpc.exportHtml → toast. Resolves false when the
 * user cancels the save dialog; throws on export failure.
 */

import { toast } from "../stores/toast";

export async function exportSessionHtml(): Promise<boolean> {
	const outputPath = await window.omp.system.showSaveDialog("session.html");
	if (!outputPath) return false;
	const response = await window.omp.rpc.exportHtml(outputPath);
	if (!response.success) throw new Error(response.error);
	toast({ variant: "success", title: "Session exported", message: outputPath });
	return true;
}
