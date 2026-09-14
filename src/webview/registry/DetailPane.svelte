<script lang="ts">
/**
 * Everything known about one dependency, and the actions that change it.
 *
 * A button stays disabled from the moment it is pressed until the host
 * reports a terminal state, so a slow `buf dep update` cannot be started
 * twice by an impatient second click.
 */
import type { BufDep, GenConfig, ModuleDeps } from "../../shared/protocol";
import Icon from "./Icon.svelte";
import {
	type Action,
	actionKey,
	addPreview,
	bufYamlPath,
	type CommitRow,
	commitHistory,
	isDeclaredIn,
	pluginName,
	protoSummary,
	shortCommit,
	shortDate,
	type TaskRecord,
} from "./model";
import YamlPreview from "./YamlPreview.svelte";

let {
	dep,
	module,
	gen,
	history,
	tasks,
	onAction,
	onOpenUrl,
}: {
	dep: BufDep;
	module: ModuleDeps | undefined;
	gen: GenConfig | undefined;
	history: readonly CommitRow[] | undefined;
	tasks: Record<string, TaskRecord>;
	onAction: (action: Action) => void;
	onOpenUrl: (url: string) => void;
} = $props();

const declared = $derived(isDeclaredIn(module, dep));
const preview = $derived(addPreview(module, dep));
const commits = $derived(commitHistory(dep, history));

const addAction = $derived<Action>({ kind: "add", dep });
const updateAction = $derived<Action>({
	kind: "update",
	root: module?.root ?? "",
});
const genAction = $derived<Action>({ kind: "gen", root: module?.root ?? "" });

const stateOf = (action: Action): TaskRecord | undefined =>
	tasks[actionKey(action)];
const busy = (action: Action): boolean => stateOf(action)?.state === "running";
const failure = (action: Action): string | undefined => {
	const record = stateOf(action);
	return record?.state === "failed" ? (record.message ?? "Failed") : undefined;
};
</script>

<div class="min-w-0 overflow-auto pb-6">
	<header class="flex gap-3 border-b border-line px-4 py-4">
		<span
			class="grid size-11 shrink-0 place-items-center rounded-lg border border-line font-mono text-lg font-bold"
			aria-hidden="true"
		>
			{dep.module.charAt(0).toUpperCase()}
		</span>
		<div class="min-w-0">
			<h1 class="m-0 font-mono text-[17px] font-bold tracking-tight">
				{dep.module}
			</h1>
			<p class="mt-0.5 mb-2 truncate font-mono text-[11.5px] text-muted">
				{dep.name}
			</p>

			<div class="flex flex-wrap gap-1.5">
				{#if !declared}
					<button
						type="button"
						class="inline-flex items-center gap-1 rounded-sm bg-btn px-3 py-1 text-[11.5px] text-btn-fg hover:bg-btn-hover disabled:opacity-50"
						disabled={busy(addAction) || !module}
						onclick={() => onAction(addAction)}
					>
						<Icon name="plus" size={12} />
						{busy(addAction) ? "Adding…" : "Add to buf.yaml"}
					</button>
				{/if}
				<button
					type="button"
					class="rounded-sm border border-line px-3 py-1 text-[11.5px] hover:bg-hover disabled:opacity-50"
					disabled={busy(updateAction) || !module}
					onclick={() => onAction(updateAction)}
				>
					{busy(updateAction) ? "Updating…" : "buf dep update"}
				</button>
				{#if dep.cachePath}
					<button
						type="button"
						class="inline-flex items-center gap-1 rounded-sm border border-line px-3 py-1 text-[11.5px] hover:bg-hover"
						onclick={() => onOpenUrl(`https://${dep.name}`)}
					>
						Open on BSR
						<Icon name="external-link" size={11} />
					</button>
				{/if}
			</div>

			{#each [addAction, updateAction, genAction] as action (actionKey(action))}
				{#if failure(action)}
					<p class="mt-1.5 mb-0 text-[11px] text-danger">{failure(action)}</p>
				{/if}
			{/each}
		</div>
	</header>

	{#if dep.update?.error}
		<p
			class="m-0 flex items-start gap-2 border-b border-line px-4 py-2.5 text-[11.5px] text-danger"
		>
			<Icon name="warning" size={13} />
			{dep.update.error}
		</p>
	{/if}

	<dl
		class="m-0 grid grid-cols-[repeat(auto-fit,minmax(5.5rem,1fr))] border-b border-line"
	>
		<div class="border-r border-line px-3.5 py-2.5 last:border-r-0">
			<dt class="text-[9.5px] font-bold tracking-[0.06em] text-muted uppercase">
				Protos
			</dt>
			<dd class="tnum m-0 mt-0.5 font-mono text-[15px] font-bold">
				{dep.protoCount ?? "—"}
			</dd>
		</div>
		<div class="border-r border-line px-3.5 py-2.5 last:border-r-0">
			<dt class="text-[9.5px] font-bold tracking-[0.06em] text-muted uppercase">
				Behind
			</dt>
			<dd
				class="tnum m-0 mt-0.5 font-mono text-[15px] font-bold"
				class:text-warn={(dep.update?.behind ?? 0) > 0}
			>
				{dep.update?.behind ?? "—"}
			</dd>
		</div>
		<div class="border-r border-line px-3.5 py-2.5 last:border-r-0">
			<dt class="text-[9.5px] font-bold tracking-[0.06em] text-muted uppercase">
				State
			</dt>
			<dd class="m-0 mt-0.5 font-mono text-[12px]">{dep.state}</dd>
		</div>
		<div class="border-r border-line px-3.5 py-2.5 last:border-r-0">
			<dt class="text-[9.5px] font-bold tracking-[0.06em] text-muted uppercase">
				Cached
			</dt>
			<dd class="m-0 mt-0.5 font-mono text-[12px]">{protoSummary(dep)}</dd>
		</div>
	</dl>

	{#if !declared}
		<section class="border-b border-line px-4 py-3">
			<h2
				class="mb-2 text-[10px] font-bold tracking-[0.07em] text-muted uppercase"
			>
				Adding this writes
			</h2>
			<YamlPreview lines={preview} />
			<p class="mt-2 mb-0 text-[11.5px] leading-snug text-muted">
				<code class="font-mono text-[11px]">buf dep</code> has no
				<code class="font-mono text-[11px]">add</code> subcommand, so this edits
				<code class="font-mono text-[11px]"
					>{module ? bufYamlPath(module) : "buf.yaml"}</code
				>
				and then runs
				<code class="font-mono text-[11px]">buf dep update</code> to pin the commit.
			</p>
		</section>
	{/if}

	{#if commits.length > 0}
		<section class="border-b border-line px-4 py-3">
			<h2
				class="mb-2 text-[10px] font-bold tracking-[0.07em] text-muted uppercase"
			>
				Commits
			</h2>
			<ul class="m-0 flex list-none flex-col gap-px p-0">
				{#each commits as row (row.commit)}
					<li class="flex items-center gap-2.5 py-0.5 font-mono text-[11px]">
						<span class:text-ok={row.pinned} class:font-bold={row.pinned}>
							{shortCommit(row.commit)}
						</span>
						<span class="tnum text-muted">{shortDate(row.time)}</span>
						{#if row.pinned}
							<span class="text-[10px] text-ok">in buf.lock</span>
						{:else if row.latest}
							<span class="text-[10px] text-muted">latest</span>
						{/if}
						{#if row.sourceControlUrl}
							<button
								type="button"
								class="ml-auto inline-flex items-center gap-1 text-link hover:underline"
								onclick={() => onOpenUrl(row.sourceControlUrl as string)}
							>
								<Icon name="github" size={12} />
								source
							</button>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	{#if gen}
		<section class="px-4 py-3">
			<h2
				class="mb-2 text-[10px] font-bold tracking-[0.07em] text-muted uppercase"
			>
				Generate with
			</h2>
			<ul class="m-0 flex list-none flex-col gap-px p-0">
				{#each gen.plugins as plugin (plugin.ref)}
					<li class="flex items-center gap-2.5 py-0.5 font-mono text-[11px]">
						<span class="text-sym-method"><Icon name="plug" size={13} /></span>
						<span class="truncate">{pluginName(plugin.ref)}</span>
						<span class="truncate text-muted">→ {plugin.out}</span>
					</li>
				{/each}
			</ul>
			<button
				type="button"
				class="mt-2.5 inline-flex items-center gap-1 rounded-sm bg-btn px-3 py-1 text-[11.5px] text-btn-fg hover:bg-btn-hover disabled:opacity-50"
				disabled={busy(genAction) || !module}
				onclick={() => onAction(genAction)}
			>
				{busy(genAction) ? "Generating…" : "buf generate"}
			</button>
		</section>
	{/if}
</div>
