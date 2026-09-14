/**
 * Tests for the environment check.
 *
 * The install hints are the part worth pinning. They are the first thing a
 * reader on a new machine acts on, and they are platform-specific — so the
 * only platform they can be verified on by running is whichever one the suite
 * happens to be executing, which is never the one where a wrong hint hurts.
 * `inspectEnvironment` takes the platform as an argument for exactly that
 * reason, and these assert all three.
 *
 * The other load-bearing distinction is required versus optional. Demanding
 * `clang-format` from someone who formats with buf sends them to install
 * something they will never use, and a reader who follows one unnecessary
 * instruction stops trusting the rest of the page.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	inspectEnvironment,
	type Managers,
	type ProbeConfig,
	statusSummary,
} from "../../../doctor/environment";

/** A gapi root that is guaranteed not to exist. */
function emptyRoot(): string {
	return path.join(
		os.tmpdir(),
		`gapi-absent-${Math.random().toString(36).slice(2)}`,
	);
}

/** A gapi root with googleapis and protobuf populated. */
function populatedRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "gapi-"));
	for (const name of ["googleapis", "protobuf"]) {
		const dir = path.join(root, name);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "marker.proto"), "");
	}
	return root;
}

/** Binary names that certainly do not resolve. */
const ABSENT: ProbeConfig = {
	apiLinterPath: "api-linter-does-not-exist-xyz",
	bufPath: "buf-does-not-exist-xyz",
	clangFormatPath: "clang-format-does-not-exist-xyz",
};

/** A machine with no package manager at all. */
const NO_MANAGERS: Managers = {
	brew: false,
	apt: false,
	dnf: false,
	pacman: false,
	winget: false,
	choco: false,
	scoop: false,
	go: false,
};

describe("requirement levels", () => {
	test("separates what is required from what is merely nice", async () => {
		const report = await inspectEnvironment({
			...ABSENT,
			gapiRoot: emptyRoot(),
		});
		const by = new Map(report.dependencies.map((d) => [d.id, d]));

		// Without these nothing lints at all.
		expect(by.get("api-linter")?.requirement).toBe("required");
		expect(by.get("googleapis")?.requirement).toBe("required");
		expect(by.get("protobuf")?.requirement).toBe("required");
		// buf costs you formatting and the registry, not linting.
		expect(by.get("buf")?.requirement).toBe("recommended");
		// clang-format matters only if you asked for it.
		expect(by.get("clang-format")?.requirement).toBe("optional");
	});

	test("is not ready when something required is absent", async () => {
		const report = await inspectEnvironment({
			...ABSENT,
			gapiRoot: emptyRoot(),
		});
		expect(report.ready).toBe(false);
	});

	test("a missing optional tool alone does not block readiness", async () => {
		// Everything required present, clang-format absent: still ready.
		const report = await inspectEnvironment({
			apiLinterPath: process.execPath,
			bufPath: process.execPath,
			clangFormatPath: "clang-format-does-not-exist-xyz",
			gapiRoot: populatedRoot(),
		});
		expect(report.ready).toBe(true);
		const clang = report.dependencies.find((d) => d.id === "clang-format");
		expect(clang?.state).toBe("missing");
	});
});

describe("the download directory", () => {
	test("reports it missing when nothing has been downloaded", async () => {
		const root = emptyRoot();
		const report = await inspectEnvironment({ ...ABSENT, gapiRoot: root });
		expect(report.gapiRoot).toBe(root);
		expect(report.gapiRootExists).toBe(false);
		for (const id of ["googleapis", "protobuf"]) {
			expect(report.dependencies.find((d) => d.id === id)?.state).toBe(
				"missing",
			);
		}
	});

	test("finds googleapis and protobuf once they are there", async () => {
		const report = await inspectEnvironment({
			...ABSENT,
			gapiRoot: populatedRoot(),
		});
		expect(report.gapiRootExists).toBe(true);
		for (const id of ["googleapis", "protobuf"]) {
			expect(report.dependencies.find((d) => d.id === id)?.state).toBe("ok");
		}
	});

	test("an empty directory is not an install", async () => {
		// `mkdir ~/.gapi` alone must not read as "googleapis is present", or the
		// panel tells someone they are ready when no proto will resolve.
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "gapi-bare-"));
		fs.mkdirSync(path.join(root, "googleapis"), { recursive: true });
		const report = await inspectEnvironment({ ...ABSENT, gapiRoot: root });
		expect(report.dependencies.find((d) => d.id === "googleapis")?.state).toBe(
			"missing",
		);
	});
});

describe("install hints", () => {
	test("offers Homebrew on macOS", async () => {
		const report = await inspectEnvironment(
			{ ...ABSENT, gapiRoot: emptyRoot() },
			"darwin",
		);
		const buf = report.dependencies.find((d) => d.id === "buf");
		expect(buf?.installHints.map((h) => h.via)).toContain("Homebrew");
		expect(
			buf?.installHints.find((h) => h.via === "Homebrew")?.command,
		).toContain("brew install");
	});

	test("offers the platform's own managers on Linux", async () => {
		const report = await inspectEnvironment(
			{ ...ABSENT, gapiRoot: emptyRoot() },
			"linux",
		);
		const clang = report.dependencies.find((d) => d.id === "clang-format");
		const vias = clang?.installHints.map((h) => h.via) ?? [];
		expect(vias).toContain("apt");
		expect(vias).toContain("dnf");
	});

	test("offers winget on Windows and never brew", async () => {
		const report = await inspectEnvironment(
			{ ...ABSENT, gapiRoot: emptyRoot() },
			"win32",
		);
		const buf = report.dependencies.find((d) => d.id === "buf");
		const vias = buf?.installHints.map((h) => h.via) ?? [];
		expect(vias).toContain("winget");
		// Suggesting Homebrew on Windows would be a wrong instruction, which is
		// worse than no instruction.
		expect(vias).not.toContain("Homebrew");
	});

	test("keeps a hint whose manager is absent, but marks it", async () => {
		// A fresh machine's real answer is often "install Homebrew first", and a
		// page that hides the option cannot say so.
		//
		// The managers are supplied rather than probed. Asking the host whether
		// winget resolves makes the assertion a fact about the runner: this read
		// as passing everywhere except Windows, the one platform where the hints
		// are real, because GitHub's Windows image ships winget.
		const report = await inspectEnvironment(
			{ ...ABSENT, gapiRoot: emptyRoot() },
			"win32",
			NO_MANAGERS,
		);
		const buf = report.dependencies.find((d) => d.id === "buf");
		expect(buf?.installHints.length).toBeGreaterThan(0);
		for (const via of ["winget", "Scoop"]) {
			expect(buf?.installHints.find((h) => h.via === via)?.unavailable).toBe(
				true,
			);
		}
	});

	test("leaves a hint unmarked when its manager is present", async () => {
		// The other half of the contract: `unavailable` distinguishes the two,
		// so a test that only ever sees absent managers cannot tell whether the
		// flag means anything.
		const report = await inspectEnvironment(
			{ ...ABSENT, gapiRoot: emptyRoot() },
			"win32",
			{ ...NO_MANAGERS, winget: true },
		);
		const hints = report.dependencies.find((d) => d.id === "buf")?.installHints;
		expect(hints?.find((h) => h.via === "winget")?.unavailable).toBeUndefined();
		expect(hints?.find((h) => h.via === "Scoop")?.unavailable).toBe(true);
	});

	test("says the extension installs what it can install itself", async () => {
		const report = await inspectEnvironment({
			...ABSENT,
			gapiRoot: emptyRoot(),
		});
		const by = new Map(report.dependencies.map((d) => [d.id, d]));
		expect(by.get("api-linter")?.selfInstallable).toBe(true);
		expect(by.get("googleapis")?.selfInstallable).toBe(true);
		// buf is a general-purpose tool the extension has no business managing.
		expect(by.get("buf")?.selfInstallable).toBe(false);
	});
});

describe("statusSummary", () => {
	test("names the version when the linter is present", async () => {
		const report = await inspectEnvironment({
			apiLinterPath: process.execPath,
			bufPath: process.execPath,
			clangFormatPath: process.execPath,
			gapiRoot: populatedRoot(),
		});
		// `process.execPath --version` prints node's version; the point is that
		// whatever the tool reported is what reaches the status bar.
		expect(statusSummary(report)).not.toBe("Proto: setup needed");
		expect(statusSummary(report).length).toBeGreaterThan(0);
	});

	test("asks for setup when the linter is missing", async () => {
		const report = await inspectEnvironment({
			...ABSENT,
			gapiRoot: emptyRoot(),
		});
		expect(statusSummary(report)).toBe("Proto: setup needed");
	});
});

describe("install commands are the ones that actually work", () => {
	test("uses the homebrew-core name for buf, not the tap-qualified one", async () => {
		// `brew install bufbuild/buf/buf` errors with "requires the tap
		// bufbuild/buf" unless it has been tapped. buf is in homebrew-core, so
		// the bare name is both correct and shorter — and a wrong install
		// command is worse than none, since the reader runs it and then has to
		// work out why it failed.
		const report = await inspectEnvironment(
			{ ...ABSENT, gapiRoot: emptyRoot() },
			"darwin",
		);
		const brew = report.dependencies
			.find((d) => d.id === "buf")
			?.installHints.find((h) => h.via === "Homebrew");
		expect(brew?.command).toBe("brew install buf");
	});

	test("every hint is a single command, not a shell script", async () => {
		// These are offered in a modal and then run verbatim in a terminal, so
		// anything with a pipe or a chained `&&` would be both unreadable in the
		// prompt and unsafe to present as "this is what will run".
		for (const platform of ["darwin", "linux", "win32"] as const) {
			const report = await inspectEnvironment(
				{ ...ABSENT, gapiRoot: emptyRoot() },
				platform,
			);
			for (const dep of report.dependencies) {
				for (const hint of dep.installHints) {
					expect(hint.command).not.toContain("&&");
					expect(hint.command).not.toContain("|");
					expect(hint.command.split("\n")).toHaveLength(1);
				}
			}
		}
	});

	test("never suggests sudo on macOS, where nothing needs it", async () => {
		const report = await inspectEnvironment(
			{ ...ABSENT, gapiRoot: emptyRoot() },
			"darwin",
		);
		for (const dep of report.dependencies) {
			for (const hint of dep.installHints) {
				expect(hint.command).not.toContain("sudo");
			}
		}
	});
});
