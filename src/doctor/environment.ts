/**
 * What the extension needs on disk, and whether it is there.
 *
 * Free of `vscode` on purpose: everything here is filesystem and subprocess
 * work, which makes the whole check runnable in a unit test rather than only
 * inside an extension host. The view layer turns these results into a panel.
 *
 * Two of the four tools are genuinely required and two are not, and the
 * difference matters more than a checklist suggests — an install page that
 * demands `clang-format` from someone who formats with buf is telling them to
 * do unnecessary work, and they will stop trusting the rest of the page.
 */

import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** A probe must not hang the panel on a binary that never returns. */
const PROBE_TIMEOUT_MS = 5000;

/** How much the extension cares that a dependency is missing. */
export type Requirement =
	/** Nothing works without it. */
	| "required"
	/** A named feature stops working; the rest is fine. */
	| "recommended"
	/** Only needed if configured to use it. */
	| "optional";

/** The state one dependency is in. */
export type DependencyState =
	/** Found, and its version was read. */
	| "ok"
	/** Found, but too old for something the extension does. */
	| "outdated"
	/** Not found anywhere it was looked for. */
	| "missing";

/** One thing the extension depends on. */
export interface Dependency {
	readonly id: string;
	/** Name a person would recognise. */
	readonly label: string;
	/** One line on what stops working without it. */
	readonly purpose: string;
	readonly requirement: Requirement;
	readonly state: DependencyState;
	/** Version string as the tool reported it, when it ran. */
	readonly version?: string;
	/** Where it was found — a binary path, or a directory. */
	readonly location?: string;
	/** Why it is not usable, when it is not. */
	readonly detail?: string;
	/** True when the extension can install this itself. */
	readonly selfInstallable: boolean;
	/** Shell commands that would install it on this platform, best first. */
	readonly installHints: readonly InstallHint[];
}

/** One way to install a dependency on this machine. */
export interface InstallHint {
	/** Package manager or method, e.g. `Homebrew`. */
	readonly via: string;
	readonly command: string;
	/** Set when the manager itself is not installed. */
	readonly unavailable?: boolean;
}

/** The whole picture. */
export interface EnvironmentReport {
	readonly platform: NodeJS.Platform;
	readonly arch: string;
	/** `~/.gapi`, where the extension keeps what it downloads. */
	readonly gapiRoot: string;
	readonly gapiRootExists: boolean;
	readonly dependencies: readonly Dependency[];
	/** True when nothing required is missing. */
	readonly ready: boolean;
}

/* ------------------------------------------------------------------ *
 * Probing
 * ------------------------------------------------------------------ */

/** Runs `binary --version`, returning the first line, or undefined. */
async function probeVersion(
	binary: string,
	args: readonly string[] = ["--version"],
): Promise<{ version: string; location: string } | undefined> {
	try {
		const { stdout, stderr } = await execFileAsync(binary, [...args], {
			timeout: PROBE_TIMEOUT_MS,
		});
		// `protoc --version` and friends sometimes answer on stderr.
		const text = (stdout || stderr).trim();
		if (text.length === 0) {
			return undefined;
		}
		const version = text.split("\n")[0].trim();
		return { version, location: await resolveOnPath(binary) };
	} catch {
		return undefined;
	}
}

/**
 * Where a binary actually resolves from.
 *
 * Worth reporting rather than echoing what was configured: "api-linter" tells
 * the reader nothing when two are installed and the wrong one is first on
 * PATH, which is the failure this whole panel exists to make visible.
 */
async function resolveOnPath(binary: string): Promise<string> {
	if (binary.includes(path.sep) || binary.includes("/")) {
		return binary;
	}
	const which = process.platform === "win32" ? "where" : "which";
	try {
		const { stdout } = await execFileAsync(which, [binary], {
			timeout: PROBE_TIMEOUT_MS,
		});
		return stdout.trim().split("\n")[0].trim() || binary;
	} catch {
		return binary;
	}
}

/** True when the path is a directory holding at least one entry. */
async function hasContents(dir: string): Promise<boolean> {
	try {
		const entries = await fsp.readdir(dir);
		return entries.length > 0;
	} catch {
		return false;
	}
}

/** True when a command exists on PATH. Used to hide hints that cannot run. */
async function onPath(binary: string): Promise<boolean> {
	const which = process.platform === "win32" ? "where" : "which";
	try {
		await execFileAsync(which, [binary], { timeout: PROBE_TIMEOUT_MS });
		return true;
	} catch {
		return false;
	}
}

/* ------------------------------------------------------------------ *
 * Install hints
 * ------------------------------------------------------------------ */

/** Which package managers are usable on this machine right now. */
export interface Managers {
	readonly brew: boolean;
	readonly apt: boolean;
	readonly dnf: boolean;
	readonly pacman: boolean;
	readonly winget: boolean;
	readonly choco: boolean;
	readonly scoop: boolean;
	readonly go: boolean;
}

/** Probes for the package managers this platform might have. */
export async function detectManagers(
	platform: NodeJS.Platform = process.platform,
): Promise<Managers> {
	const [brew, apt, dnf, pacman, winget, choco, scoop, go] = await Promise.all([
		platform === "darwin" || platform === "linux" ? onPath("brew") : false,
		platform === "linux" ? onPath("apt-get") : false,
		platform === "linux" ? onPath("dnf") : false,
		platform === "linux" ? onPath("pacman") : false,
		platform === "win32" ? onPath("winget") : false,
		platform === "win32" ? onPath("choco") : false,
		platform === "win32" ? onPath("scoop") : false,
		onPath("go"),
	]);
	return { brew, apt, dnf, pacman, winget, choco, scoop, go };
}

/**
 * Install commands for one tool, ordered so the first is the one to run.
 *
 * A manager that is not installed still appears, marked unavailable, rather
 * than being hidden: on a fresh machine the answer is often "install Homebrew
 * first", and a page that silently omits the option cannot say so.
 */
function hintsFor(
	id: string,
	platform: NodeJS.Platform,
	managers: Managers,
): InstallHint[] {
	const hints: InstallHint[] = [];
	const add = (via: string, command: string, available: boolean): void => {
		hints.push({ via, command, unavailable: available ? undefined : true });
	};

	if (id === "buf") {
		if (platform === "darwin" || platform === "linux") {
			// `buf`, not `bufbuild/buf/buf`: it is in homebrew-core, and the
			// tap-qualified name errors out unless the tap is added first.
			add("Homebrew", "brew install buf", managers.brew);
		}
		if (platform === "win32") {
			add("winget", "winget install Buf.Buf", managers.winget);
			add("Scoop", "scoop install buf", managers.scoop);
		}
		add("Go", "go install github.com/bufbuild/buf/cmd/buf@latest", managers.go);
		return hints;
	}

	if (id === "api-linter") {
		// No package manager ships it, so Go is the only build-from-source route
		// and the extension's own download is the path most people should take.
		add(
			"Go",
			"go install github.com/googleapis/api-linter/cmd/api-linter@latest",
			managers.go,
		);
		return hints;
	}

	if (id === "clang-format") {
		if (platform === "darwin") {
			add("Homebrew", "brew install clang-format", managers.brew);
		}
		if (platform === "linux") {
			add("apt", "sudo apt-get install -y clang-format", managers.apt);
			add("dnf", "sudo dnf install -y clang-tools-extra", managers.dnf);
			add("pacman", "sudo pacman -S clang", managers.pacman);
			add("Homebrew", "brew install clang-format", managers.brew);
		}
		if (platform === "win32") {
			add("winget", "winget install LLVM.LLVM", managers.winget);
			add("Chocolatey", "choco install llvm", managers.choco);
		}
		return hints;
	}

	return hints;
}

/* ------------------------------------------------------------------ *
 * The report
 * ------------------------------------------------------------------ */

/** Paths the caller resolves from settings, so this module stays vscode-free. */
export interface ProbeConfig {
	readonly apiLinterPath: string;
	readonly bufPath: string;
	readonly clangFormatPath: string;
	/** `~/.gapi`, overridable for tests. */
	readonly gapiRoot?: string;
}

/**
 * Checks everything and reports it.
 *
 * @param config - Binary paths, normally read from settings
 * @param platform - Overridable so hint selection is testable
 * @param managers - Overridable for the same reason. `platform` alone decides
 * which managers are *considered*; whether each one resolves is still a fact
 * about the host, so a test asserting "absent managers are marked" only holds
 * on a host that happens to lack them. Passing them in makes that assertion
 * about the branch under test rather than about the runner.
 * @returns What is installed, what is missing, and how to fix it
 */
export async function inspectEnvironment(
	config: ProbeConfig,
	platform: NodeJS.Platform = process.platform,
	managerOverride?: Managers,
): Promise<EnvironmentReport> {
	const gapiRoot = config.gapiRoot ?? path.join(os.homedir(), ".gapi");
	const managers = managerOverride ?? (await detectManagers(platform));

	const [linter, buf, clang, googleapis, protobuf, rootExists] =
		await Promise.all([
			probeVersion(config.apiLinterPath),
			probeVersion(config.bufPath),
			probeVersion(config.clangFormatPath),
			hasContents(path.join(gapiRoot, "googleapis")),
			hasContents(path.join(gapiRoot, "protobuf")),
			hasContents(gapiRoot),
		]);

	const dependencies: Dependency[] = [
		{
			id: "api-linter",
			label: "api-linter",
			purpose: "Runs the AIP rules. Nothing is linted without it.",
			requirement: "required",
			state: linter ? "ok" : "missing",
			version: linter?.version,
			location: linter?.location,
			detail: linter
				? undefined
				: `Not found as "${config.apiLinterPath}". The extension can download it.`,
			selfInstallable: true,
			installHints: hintsFor("api-linter", platform, managers),
		},
		{
			id: "googleapis",
			label: "googleapis protos",
			purpose:
				"Resolves google/api/* imports. Annotated protos do not compile without them.",
			requirement: "required",
			state: googleapis ? "ok" : "missing",
			location: path.join(gapiRoot, "googleapis"),
			detail: googleapis
				? undefined
				: "Not downloaded yet. The extension fetches these itself.",
			selfInstallable: true,
			installHints: [],
		},
		{
			id: "protobuf",
			label: "protobuf well-known types",
			purpose:
				"Resolves google/protobuf/* imports such as Timestamp and FieldMask.",
			requirement: "required",
			state: protobuf ? "ok" : "missing",
			location: path.join(gapiRoot, "protobuf"),
			detail: protobuf
				? undefined
				: "Not downloaded yet. The extension fetches these itself.",
			selfInstallable: true,
			installHints: [],
		},
		{
			id: "buf",
			label: "buf",
			purpose:
				"Formats protos, resolves registry dependencies, and generates code.",
			requirement: "recommended",
			state: buf ? "ok" : "missing",
			version: buf?.version,
			location: buf?.location,
			detail: buf
				? undefined
				: "Formatting falls back to the built-in indent, and the Registry cannot resolve modules.",
			selfInstallable: false,
			installHints: hintsFor("buf", platform, managers),
		},
		{
			id: "clang-format",
			label: "clang-format",
			purpose: 'Only used when gapi.formatter is set to "clang-format".',
			requirement: "optional",
			state: clang ? "ok" : "missing",
			version: clang?.version,
			location: clang?.location,
			detail: clang ? undefined : "Not needed unless you select it explicitly.",
			selfInstallable: false,
			installHints: hintsFor("clang-format", platform, managers),
		},
	];

	return {
		platform,
		arch: process.arch,
		gapiRoot,
		gapiRootExists: rootExists,
		dependencies,
		ready: dependencies.every(
			(dep) => dep.requirement !== "required" || dep.state === "ok",
		),
	};
}

/** A short line for the status bar, e.g. `api-linter 2.3.1`. */
export function statusSummary(report: EnvironmentReport): string {
	const linter = report.dependencies.find((d) => d.id === "api-linter");
	if (linter?.state !== "ok") {
		return "Proto: setup needed";
	}
	// The version strings are `api-linter 2.3.1` and `buf 1.72.0`; the tool's
	// own name is already in them, so printing it again reads as a stutter.
	return linter.version ?? "api-linter";
}
