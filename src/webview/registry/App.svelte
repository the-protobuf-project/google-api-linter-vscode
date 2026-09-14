<script lang="ts">
/**
 * Stateful shell for the Proto Registry.
 *
 * State lives here rather than in `main.ts` because runes are a compiler
 * feature: only `.svelte` files go through the Svelte compiler, so a
 * `$state()` written in a plain `.ts` module survives bundling as a call to
 * an undefined global and throws the moment the panel loads.
 */
import type { DependencyModel } from "../../shared/protocol";
import {
	announceReady,
	loadState,
	onHostMessage,
	post,
	saveState,
} from "../shared/bridge";
import { FIXTURE_HISTORY, FIXTURE_MODEL } from "./fixture";
import {
	type Action,
	actionKey,
	buildRail,
	DEFAULT_FILTER,
	type FilterId,
	firstPopulated,
	newTaskId,
	type TaskRecord,
} from "./model";
import Registry from "./Registry.svelte";

/** What survives the panel being hidden and its DOM torn down. */
interface PanelState {
	readonly filter: FilterId;
	readonly query: string;
	readonly selectedName?: string;
}

/**
 * A task whose terminal message never arrives must not disable its button
 * forever. The host always sends one, but a crash between spawn and reply is
 * exactly the case a stuck UI cannot recover from.
 */
const TASK_TIMEOUT_MS = 240_000;

const restored = loadState<PanelState>();

let model = $state<DependencyModel | null>(null);
let filter = $state<FilterId>(restored?.filter ?? DEFAULT_FILTER);
let query = $state(restored?.query ?? "");
let selectedName = $state<string | undefined>(restored?.selectedName);
let tasks = $state<Record<string, TaskRecord>>({});
/** True once a real payload has arrived, so the fixture never overwrites it. */
let live = $state(false);

/** Maps a live task id back to the action key its progress belongs to. */
const pending = new Map<string, { key: string; timer: number }>();

function persist(): void {
	saveState({ filter, query, selectedName } satisfies PanelState);
}

function settle(taskId: string, record: TaskRecord): void {
	const entry = pending.get(taskId);
	if (!entry) {
		return;
	}
	tasks = { ...tasks, [entry.key]: record };
	if (record.state !== "running") {
		clearTimeout(entry.timer);
		pending.delete(taskId);
	}
}

$effect(() => {
	const unsubscribe = onHostMessage((message) => {
		if (message.type === "registry/update") {
			model = message.model;
			live = true;
			// A cold panel opening on an empty filter looks broken; land on
			// the first row that has anything in it instead.
			if (!restored?.filter) {
				filter = firstPopulated(buildRail(message.model));
			}
			return;
		}
		if (message.type === "registry/focus") {
			// Opened from the Registries view: scope to that host, and drop the
			// selection, which belonged to a module on a different registry.
			filter = (
				message.remote ? `remote:${message.remote}` : DEFAULT_FILTER
			) as FilterId;
			selectedName = undefined;
			persist();
			return;
		}
		if (message.type === "task/progress") {
			settle(message.taskId, {
				taskId: message.taskId,
				state: message.state,
				message: message.message,
			});
		}
	});
	announceReady();

	// Outside the host nothing will ever answer `ready`, so the fixture
	// stands in for screenshots and review. It never replaces real data.
	if (!("acquireVsCodeApi" in globalThis) && !live) {
		model = FIXTURE_MODEL;
	}
	return unsubscribe;
});

function runAction(action: Action): void {
	const key = actionKey(action);
	if (tasks[key]?.state === "running") {
		return;
	}
	const taskId = newTaskId();
	const timer = setTimeout(() => {
		settle(taskId, {
			taskId,
			state: "failed",
			message: "Timed out waiting for the extension.",
		});
	}, TASK_TIMEOUT_MS) as unknown as number;
	pending.set(taskId, { key, timer });
	tasks = { ...tasks, [key]: { taskId, state: "running" } };

	switch (action.kind) {
		case "add":
			post({
				type: "dep/add",
				taskId,
				name: action.dep.name,
				bufYaml: action.dep.declaredIn ?? "",
			});
			return;
		case "update":
			post({ type: "dep/update", taskId, root: action.root });
			return;
		case "gen":
			post({ type: "gen/run", taskId, root: action.root });
			return;
		case "check":
			post({ type: "dep/checkUpdates", taskId });
			return;
	}
}
</script>

<Registry
	{model}
	{filter}
	{query}
	{selectedName}
	{tasks}
	history={live ? {} : FIXTURE_HISTORY}
	onFilter={(id: FilterId) => {
		filter = id;
		selectedName = undefined;
		persist();
	}}
	onQuery={(value: string) => {
		query = value;
		persist();
	}}
	onSelect={(name: string) => {
		selectedName = name;
		persist();
	}}
	onAction={runAction}
	onOpenUrl={(url: string) => post({ type: "openExternal", url })}
/>
