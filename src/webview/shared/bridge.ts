/**
 * The webview side of the host bridge.
 *
 * `acquireVsCodeApi` may be called exactly once per webview document — a second
 * call throws — so the handle is taken here and shared. Every panel imports
 * this rather than reaching for the global.
 */

import type { HostMessage, PanelMessage } from "../../shared/protocol";

/** The subset of the injected API this extension uses. */
interface VsCodeApi {
	postMessage(message: PanelMessage): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/**
 * Undefined when the bundle runs outside the host — a browser harness, a test.
 * Callers degrade instead of throwing, so a panel opened in a plain page still
 * renders with whatever state it was seeded with.
 */
const api: VsCodeApi | undefined =
	typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

/** Send one message to the extension host. */
export function post(message: PanelMessage): void {
	api?.postMessage(message);
}

/**
 * Subscribe to messages from the host.
 *
 * @param handler - Called for each well-formed {@link HostMessage}
 * @returns A function that removes the listener
 */
export function onHostMessage(
	handler: (message: HostMessage) => void,
): () => void {
	const listener = (event: MessageEvent): void => {
		const data = event.data as HostMessage | undefined;
		// The host is not the only possible sender: anything that can reach the
		// frame can post to it. Ignore whatever does not look like our protocol.
		if (data && typeof data === "object" && typeof data.type === "string") {
			handler(data);
		}
	};
	window.addEventListener("message", listener);
	return () => window.removeEventListener("message", listener);
}

/**
 * Panel state that survives the view being hidden.
 *
 * VS Code tears a hidden webview's DOM down and replays this on the way back,
 * so anything the reader would be annoyed to lose — scroll position, the open
 * section, the search box — belongs here rather than in a component field.
 */
export function saveState(state: unknown): void {
	api?.setState(state);
}

/** The state stored by {@link saveState}, or `undefined` on a cold start. */
export function loadState<T>(): T | undefined {
	return api?.getState() as T | undefined;
}

/** Tell the host this panel has mounted and wants its first payload. */
export function announceReady(): void {
	post({ type: "ready" });
}
