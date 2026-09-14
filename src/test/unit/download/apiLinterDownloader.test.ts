/**
 * Tests for `ApiLinterDownloader`'s release resolution.
 *
 * The contract worth pinning is the one upstream broke: a release tag is not a
 * promise that a build exists for this machine. v2.4.0 shipped a single
 * `api-linter.tar.gz` holding only the Windows executable, and reading
 * `releases/latest` and stopping there left every other platform with no linter
 * at all. So the downloader has to walk back through the release history, and
 * it has to do that without quietly reaching for a pre-release or a draft,
 * which is not what `releases/latest` would ever have handed it.
 *
 * The daily update check shares that resolution deliberately: offering an
 * update to a tag whose download cannot succeed is a prompt that fails every
 * time it is accepted.
 *
 * GitHub is mocked; `tar` is not. Archives are built on disk and extracted for
 * real, which is what catches a mismatch between what a release unpacks to and
 * where the extension looks for it -- the Windows build unpacks to
 * `api-linter.exe`, every other to `api-linter`.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApiLinterDownloader } from "../../../download/apiLinterDownloader";
import * as ACTUAL_HTTP from "../../../utils/httpClient";
import * as ACTUAL_PLATFORM from "../../../utils/platformUtils";

const LATEST_URL =
	"https://api.github.com/repos/googleapis/api-linter/releases/latest";
const HISTORY_URL =
	"https://api.github.com/repos/googleapis/api-linter/releases?per_page=20";

/** What a release archive unpacks to on the host running these tests. */
const BINARY_NAME = os.platform() === "win32" ? "api-linter.exe" : "api-linter";

let tmpRoot: string;
/** The archive `downloadFile` hands back, swapped per test. */
let servedArchive: string;
let responses: Record<string, unknown>;
let requested: string[];
let homedir: ReturnType<typeof spyOn<typeof os, "homedir">>;
/** Where the downloader under test installs to. */
let installDir: string;

const silent = { appendLine: () => {} };

/**
 * A downloader rooted in a home directory of its own. Bun resolves the real
 * home at startup and ignores a mutated `HOME`, so the function itself has to
 * be replaced -- without that these tests overwrite a developer's own install.
 */
const downloader = () => {
	const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
	homedir.mockReturnValue(home);
	installDir = path.join(home, ".gapi");
	return new ApiLinterDownloader(silent);
};

const asset = (name: string) => ({
	name,
	browser_download_url: `https://example.invalid/${name}`,
});

const release = (
	tag: string,
	names: string[],
	flags: { prerelease?: boolean; draft?: boolean } = {},
) => ({ tag_name: tag, assets: names.map(asset), ...flags });

/** The shape of the broken v2.4.0: one archive, Windows only. */
const BROKEN_LATEST = release("v2.4.0", ["api-linter.tar.gz"]);

/** Builds a real .tar.gz containing `entry` and returns its path. */
const archiveContaining = (label: string, entry: string): string => {
	const dir = fs.mkdtempSync(path.join(tmpRoot, `${label}-`));
	fs.writeFileSync(path.join(dir, entry), "#!/bin/sh\nexit 0\n");
	const archive = path.join(tmpRoot, `${label}.tar.gz`);
	cp.execFileSync("tar", ["-czf", archive, "-C", dir, entry]);
	return archive;
};

beforeAll(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gapi-downloader-"));
	servedArchive = archiveContaining("good", BINARY_NAME);
	homedir = spyOn(os, "homedir");

	mock.module("../../../utils/httpClient", () => ({
		...ACTUAL_HTTP,
		fetchJson: async (url: string) => {
			requested.push(url);
			const body = responses[url];
			if (body === undefined) {
				throw new Error(`unexpected request: ${url}`);
			}
			return body;
		},
		downloadFile: async (_url: string, dest: string) => {
			fs.copyFileSync(servedArchive, dest);
		},
	}));
	// Pinned so the assertions read the same on every runner.
	mock.module("../../../utils/platformUtils", () => ({
		...ACTUAL_PLATFORM,
		getPlatform: () => "darwin",
		getArch: () => "arm64",
	}));
});

beforeEach(() => {
	responses = {};
	requested = [];
});

afterAll(() => {
	mock.module("../../../utils/httpClient", () => ACTUAL_HTTP);
	mock.module("../../../utils/platformUtils", () => ACTUAL_PLATFORM);
	homedir.mockRestore();
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("release resolution", () => {
	test("installs from the latest release when it has a matching build", async () => {
		responses = {
			[LATEST_URL]: release("v2.3.1", [
				"api-linter-2.3.1-darwin-amd64.tar.gz",
				"api-linter-2.3.1-darwin-arm64.tar.gz",
				"api-linter-2.3.1-windows-amd64.tar.gz",
			]),
		};

		const dl = downloader();
		await dl.downloadBinary();

		expect(await dl.getBinaryVersion()).toBe("v2.3.1");
		// A usable latest must not cost a second round trip.
		expect(requested).toEqual([LATEST_URL]);
	});

	test("falls back to the newest earlier release that has one", async () => {
		responses = {
			[LATEST_URL]: BROKEN_LATEST,
			[HISTORY_URL]: [
				BROKEN_LATEST,
				release("v2.3.1", ["api-linter-2.3.1-darwin-arm64.tar.gz"]),
				release("v2.3.0", ["api-linter-2.3.0-darwin-arm64.tar.gz"]),
			],
		};

		const dl = downloader();
		await dl.downloadBinary();

		expect(await dl.getBinaryVersion()).toBe("v2.3.1");
	});

	test("skips drafts and pre-releases while falling back", async () => {
		responses = {
			[LATEST_URL]: BROKEN_LATEST,
			[HISTORY_URL]: [
				BROKEN_LATEST,
				release(
					"v2.4.0-beta.1",
					["api-linter-2.4.0-beta.1-darwin-arm64.tar.gz"],
					{ prerelease: true },
				),
				release("v2.3.2", ["api-linter-2.3.2-darwin-arm64.tar.gz"], {
					draft: true,
				}),
				release("v2.3.1", ["api-linter-2.3.1-darwin-arm64.tar.gz"]),
			],
		};

		const dl = downloader();
		await dl.downloadBinary();

		expect(await dl.getBinaryVersion()).toBe("v2.3.1");
	});

	test("reports the platform, what was published, and a way out when nothing matches", async () => {
		responses = {
			[LATEST_URL]: BROKEN_LATEST,
			[HISTORY_URL]: [
				BROKEN_LATEST,
				release("v2.3.1", ["api-linter-2.3.1-linux-amd64.tar.gz"]),
			],
		};

		const error = await downloader()
			.downloadBinary()
			.then(
				() => undefined,
				(e: Error) => e,
			);

		expect(error?.message).toContain("darwin-arm64");
		expect(error?.message).toContain("v2.4.0");
		expect(error?.message).toContain("api-linter.tar.gz");
		expect(error?.message).toContain("gapi.binaryPath");
	});
});

describe("extraction", () => {
	test("installs the binary and removes the archive", async () => {
		responses = {
			[LATEST_URL]: release("v2.3.1", ["api-linter-2.3.1-darwin-arm64.tar.gz"]),
		};

		await downloader().downloadBinary();

		expect(fs.existsSync(path.join(installDir, BINARY_NAME))).toBe(true);
		expect(fs.existsSync(path.join(installDir, "api-linter.tar.gz"))).toBe(
			false,
		);
	});

	test("fails loudly when the archive holds something else", async () => {
		responses = {
			[LATEST_URL]: release("v2.3.1", ["api-linter-2.3.1-darwin-arm64.tar.gz"]),
		};
		const previous = servedArchive;
		servedArchive = archiveContaining("wrong", "README.md");

		try {
			const error = await downloader()
				.downloadBinary()
				.then(
					() => undefined,
					(e: Error) => e,
				);

			expect(error?.message).toContain(BINARY_NAME);
		} finally {
			servedArchive = previous;
		}
	});
});
