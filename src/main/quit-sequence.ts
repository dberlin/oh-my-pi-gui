/**
 * Quit sequencing for Electron's `before-quit`.
 *
 * Releasing sidecars and SSH connections is async, but `before-quit` is
 * synchronous, so the first quit request cancels the quit, drains those
 * resources, then asks to quit again. The second request MUST land on a fresh
 * macrotask: an `app.quit()` issued from the promise continuation of the
 * sequence we just cancelled does not terminate the app, which is what left ⌘Q
 * needing a second press.
 */

export interface QuitSequenceDeps {
	/** Async teardown. Resolves (or rejects) once resources are released. */
	cleanup: () => Promise<void>;
	/** Ask the app to quit again once draining finished. */
	quit: () => void;
	/** Defer the re-quit onto a later macrotask (`setImmediate` in production). */
	schedule: (run: () => void) => void;
	/** Reports a cleanup failure; draining continues either way. */
	onError: (error: unknown) => void;
}

/**
 * Body of the `before-quit` handler. Call with `event.preventDefault` as
 * `cancelQuit`; once draining has finished the handler stops cancelling so the
 * next request terminates the app normally (windows still persist their state).
 */
export function createQuitSequence(deps: QuitSequenceDeps): (cancelQuit: () => void) => void {
	let started = false;
	let drained = false;
	return cancelQuit => {
		// Resources are already released — let this quit run to completion.
		if (drained) return;
		cancelQuit();
		if (started) return;
		started = true;
		void deps
			.cleanup()
			.catch(deps.onError)
			.finally(() => {
				drained = true;
				deps.schedule(deps.quit);
			});
	};
}
