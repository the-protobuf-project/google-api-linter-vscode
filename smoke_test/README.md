# End-to-End Testing

Two ways to test the extension: **manual (recommended for quick checks)** and **automated**.

---

## 1. Manual E2E (Run Extension + smoke workspace)

Use this to try the extension in a real VS Code window with the smoke-test proto files.

### Option A: From VS Code (Debug panel)

1. **Build** the extension (if needed):
   ```bash
   bun run compile
   ```

2. Open the repo root in VS Code.

3. **Run the extension**:
   - Open **Run and Debug** (Ctrl+Shift+D / Cmd+Shift+D).
   - Choose **"Run Extension (Smoke Test)"**.
   - Press **F5** or click the green play button.

4. A **new VS Code window** opens with the `smoke_test/protobuf` folder loaded. The extension activates because that folder contains `workspace.protobuf.yaml`.

5. **Manually verify**:
   - Open `protobuf/service/service.proto` or `message.proto`.
   - **Linting**: Save the file and check the **Problems** panel and **Output** → "Google API Linter".
   - **Outline**: Open **Outline** view; you should see messages, services, enums, rpcs.
   - **Completions**: Type `message ` or `rpc ` and confirm suggestions with type hints.
   - **Go to definition**: Ctrl+Click (Cmd+Click) on a type (e.g. `Todo`, `CreateTodoRequest`).
   - **Find references**: Right-click a type → "Find All References".
   - **Hover**: Hover over a message/service/rpc name for docs.
   - **Folding**: Use the gutter to fold message/service blocks.
   - **Snippets**: Type `proto3` or `message` and accept a snippet.

### Option B: From terminal

```bash
# Build
bun run compile

# Open VS Code with extension loaded, using smoke-test folder as workspace
code --extensionDevelopmentPath="$PWD" smoke_test/protobuf
```

Then use the same manual checks as in Option A.

---

## 2. Automated E2E tests

Automated tests run the extension in a headless VS Code instance and assert on basic behavior.

### Run automated E2E

```bash
bun run compile
bun run test:e2e
```

Or with Bun (default):

```bash
bun run compile
bun run test:e2e
```

**Note:** The first run downloads a VS Code build into `.vscode-test/` (one-time, ~160MB). If you see "Operation not permitted" or unzip errors, run the command outside a sandbox/restricted environment (e.g. in your local terminal). You can use **manual E2E** (Option A or B above) without downloading anything.

### What they cover

- Extension activates when the workspace contains `workspace.protobuf.yaml`.
- Proto files are recognized and the extension provides document symbols (outline).
- Linter runs (no crash); diagnostics may or may not be present depending on api-linter.

Add more tests under `src/test/e2e/` as needed.

---

## Smoke workspace layout

```
smoke_test/protobuf/
├── workspace.protobuf.yaml   # Required for extension activation
├── buf.yaml
├── buf.gen.yaml
└── protobuf/
    └── service/
        ├── message.proto
        └── service.proto
```

The extension only activates when `workspace.protobuf.yaml` is present in the workspace root, so E2E (manual or automated) must run with this folder (or one that contains that file) as the workspace.
