//
// Tests for the glob dialect shared by `.api-linter.yaml` path scoping and
// `workspace.protobuf.yaml`'s `exclude` key.
//
// These are line comments on purpose: almost every interesting pattern here
// contains a doubled star followed by a slash, which closes a block comment.
//
// The contract that matters is the one api-linter itself implements, because a
// pattern that means one thing to the extension and another to the binary is
// worse than no exclusion at all. Two of its properties are easy to get wrong
// and are pinned below: a doubled star matches zero segments as readily as
// many, and a single star never crosses a separator -- so "vendor/*" covers a
// proto sitting in vendor but not one nested a directory deeper.
//
// The third case is ours rather than api-linter's: a bare directory name is
// expanded to cover the tree beneath it, because "exclude: vendor" is what
// people write and matching it literally would silently exclude nothing.
//

import { describe, expect, test } from "bun:test";
import {
	createGlobMatcher,
	expandPattern,
	globToRegExp,
	matchesGlob,
	toPosix,
} from "../../../utils/glob";

describe("matchesGlob", () => {
	test("a doubled star spans any number of segments, including none", () => {
		expect(matchesGlob("book.proto", "**/*.proto")).toBe(true);
		expect(matchesGlob("pkg/v1/book.proto", "**/*.proto")).toBe(true);
		expect(matchesGlob("a/b/c/d/book.proto", "**/*.proto")).toBe(true);
	});

	test("a trailing doubled star takes the whole remainder", () => {
		expect(matchesGlob("vendor/book.proto", "vendor/**")).toBe(true);
		expect(matchesGlob("vendor/deep/book.proto", "vendor/**")).toBe(true);
		expect(matchesGlob("vendored/book.proto", "vendor/**")).toBe(false);
	});

	test("an interior doubled star still requires what follows it", () => {
		expect(matchesGlob("a/book.proto", "a/**/book.proto")).toBe(true);
		expect(matchesGlob("a/b/c/book.proto", "a/**/book.proto")).toBe(true);
		expect(matchesGlob("a/b/shelf.proto", "a/**/book.proto")).toBe(false);
	});

	test("a single star stays inside one segment", () => {
		expect(matchesGlob("vendor/book.proto", "vendor/*.proto")).toBe(true);
		expect(matchesGlob("vendor/deep/book.proto", "vendor/*.proto")).toBe(false);
	});

	test("a question mark is exactly one character, never a separator", () => {
		expect(matchesGlob("v1.proto", "v?.proto")).toBe(true);
		expect(matchesGlob("v12.proto", "v?.proto")).toBe(false);
		expect(matchesGlob("a/b.proto", "a?b.proto")).toBe(false);
	});

	test("dots are literal, not the regex wildcard", () => {
		expect(matchesGlob("bookxproto", "book.proto")).toBe(false);
		expect(matchesGlob("book.proto", "book.proto")).toBe(true);
	});

	test("patterns anchor at both ends", () => {
		expect(matchesGlob("src/vendor/book.proto", "vendor/**")).toBe(false);
		expect(matchesGlob("vendor/book.proto.bak", "vendor/*.proto")).toBe(false);
	});

	test("matches a windows path against a posix pattern", () => {
		expect(matchesGlob("vendor\\deep\\book.proto", "vendor/**")).toBe(true);
	});
});

describe("expandPattern", () => {
	test("a bare directory name also covers everything beneath it", () => {
		expect(expandPattern("vendor")).toEqual(["vendor", "vendor/**"]);
	});

	test("a trailing slash means the same thing as no trailing slash", () => {
		expect(expandPattern("vendor/")).toEqual(["vendor", "vendor/**"]);
	});

	test("a pattern that already has a wildcard is left alone", () => {
		expect(expandPattern("vendor/**")).toEqual(["vendor/**"]);
		expect(expandPattern("**/*.pb.proto")).toEqual(["**/*.pb.proto"]);
	});

	test("drops an empty or whitespace-only entry", () => {
		expect(expandPattern("   ")).toEqual([]);
		expect(expandPattern("/")).toEqual([]);
	});
});

describe("createGlobMatcher", () => {
	test("a bare directory name excludes the tree under it", () => {
		const matches = createGlobMatcher(["vendor", "third_party"]);
		expect(matches("vendor/book.proto")).toBe(true);
		expect(matches("vendor/deep/nested/book.proto")).toBe(true);
		expect(matches("third_party/a.proto")).toBe(true);
		expect(matches("src/book.proto")).toBe(false);
	});

	test("an empty pattern list matches nothing", () => {
		const matches = createGlobMatcher([]);
		expect(matches("anything.proto")).toBe(false);
	});

	test("a file pattern excludes only the files it names", () => {
		const matches = createGlobMatcher(["**/*.pb.proto"]);
		expect(matches("gen/book.pb.proto")).toBe(true);
		expect(matches("gen/book.proto")).toBe(false);
	});
});

describe("toPosix", () => {
	test("normalizes separators and strips a leading ./", () => {
		expect(toPosix("a\\b\\c.proto")).toBe("a/b/c.proto");
		expect(toPosix("./a/b.proto")).toBe("a/b.proto");
	});
});

describe("globToRegExp", () => {
	test("escapes regex metacharacters that are literal in a glob", () => {
		expect(globToRegExp("a+b.proto").test("a+b.proto")).toBe(true);
		expect(globToRegExp("a+b.proto").test("aab.proto")).toBe(false);
		expect(globToRegExp("a(b).proto").test("a(b).proto")).toBe(true);
	});
});
