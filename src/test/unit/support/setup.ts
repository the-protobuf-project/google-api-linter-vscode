/**
 * Test preload: makes `import "vscode"` resolve to the stub.
 *
 * Registered through `bunfig.toml`'s `preload`, so it runs before any test file
 * imports extension code. Without it every module under test fails to resolve
 * at import time, which reads as a mysterious "Cannot find module 'vscode'"
 * rather than a missing stub.
 */

import { mock } from "bun:test";
import * as stub from "./vscode";

mock.module("vscode", () => stub);
