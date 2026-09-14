const esbuild = require("esbuild");
const esbuildSvelte = require("esbuild-svelte");
const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

/**
 * Strips types from `<script lang="ts">` blocks.
 *
 * `svelte-preprocess` is the usual answer, but it calls
 * `ts.convertCompilerOptionsFromJson`, which TypeScript 7 removed — this repo
 * is on `typescript@^7`. esbuild already parses TS and is already a dependency,
 * so it does the erasure instead. Type *checking* is not this plugin's job:
 * `tsc -p tsconfig.webview.json` covers that separately.
 */
const typescriptPreprocessor = {
	name: "esbuild-ts",
	script: async ({ content, attributes }) => {
		if (attributes.lang !== "ts") {
			return { code: content };
		}
		const { code, map } = await esbuild.transform(content, {
			loader: "ts",
			target: "es2022",
			// `verbatimModuleSyntax` is what keeps component imports alive.
			// esbuild sees only the `<script>` block, never the template, so
			// `import Details from "./Details.svelte"` looks unused to it and is
			// dropped — the component then throws "Details is not defined" at
			// mount. With this on, only `import type` is erased and every value
			// import survives for the Svelte compiler to bind to the template.
			tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
			sourcemap: true,
		});
		return { code, map };
	},
};

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const root = __dirname;
const outWebview = path.join(root, "out", "webview");

/**
 * The extension host bundle. Node platform, `vscode` left external — the host
 * provides it and bundling it produces a module that cannot load.
 */
const extensionConfig = {
	entryPoints: [path.join(root, "src", "extension.ts")],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "node18",
	outfile: path.join(root, "out", "extension.js"),
	external: ["vscode"],
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
};

/**
 * The webview bundles. Browser platform and ESM: a webview is an iframe, so
 * there is no `require` and no Node built-in to fall back on.
 *
 * One entry per panel rather than one shared bundle. The Details view loads on
 * every selection change in the sidebar; making it carry the Registry's code
 * would pay for a panel that is usually closed.
 */
const webviewConfig = {
	entryPoints: {
		details: path.join(root, "src", "webview", "details", "main.ts"),
		registry: path.join(root, "src", "webview", "registry", "main.ts"),
	},
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	outdir: outWebview,
	splitting: false,
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	logLevel: "warning",
	plugins: [
		esbuildSvelte({
			preprocess: typescriptPreprocessor,
			compilerOptions: { css: "external", dev: !production },
		}),
	],
};

/**
 * Tailwind is run through its own CLI rather than an esbuild plugin: v4 moved
 * configuration into the stylesheet, so the CLI is the supported entry point
 * and an esbuild CSS loader would never see the `@theme` block.
 */
async function buildStyles() {
	const cli = path.join(root, "node_modules", ".bin", "tailwindcss");
	const args = [
		"--input",
		path.join(root, "src", "webview", "shared", "theme.css"),
		"--output",
		path.join(outWebview, "style.css"),
	];
	if (production) {
		args.push("--minify");
	}
	await execFileAsync(cli, args, { cwd: root });
}

async function main() {
	if (watch) {
		const [extCtx, webCtx] = await Promise.all([
			esbuild.context(extensionConfig),
			esbuild.context(webviewConfig),
		]);
		await Promise.all([extCtx.watch(), webCtx.watch(), buildStyles()]);
		console.log("[watch] esbuild watching extension + webview");
		return;
	}

	await Promise.all([
		esbuild.build(extensionConfig),
		esbuild.build(webviewConfig),
		buildStyles(),
	]);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
