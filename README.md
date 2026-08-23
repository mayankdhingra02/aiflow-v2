# Aiflow reusable official Codex worker

Phase 1 live acceptance passed for the pinned official VS Code extension. Phase 2 turns that
accepted bootstrap and exact-turn correlation into one app-lifetime worker and execution service.

The integration is pinned to:

- Extension ID: `openai.chatgpt`
- Exact supported version: `26.814.41407`
- Model roles: `luna`, `terra`, `sol`
- Reasoning effort: `low`, `medium`, `high`, `xhigh`

The worker does not launch Codex CLI or a separate App Server. It uses the already-running
official extension: `chatgpt.implementTodo` is used only for a fresh nonce-only bootstrap, and
the exact requested prompt is sent only through the follower IPC path.

## Shared architecture

Every surface uses one `OfficialCodexExecutionService`, which owns one `OfficialCodexWorker`.
Before a bootstrap it requires exactly one local workspace folder, canonicalizes both workspace
paths and requires equality, activates the official extension, and enforces the exact version.
The worker then performs bootstrap, applies model/reasoning settings, starts one exact turn,
watches only the correlated session, and supports exact-turn cancellation.

Available commands:

- `aiflow.runOfficialCodex` — internal programmatic command; not shown in the Command Palette.
- `aiflow.runClipboardOfficialCodex` — visible clipboard workflow.
- `aiflow.cancelActiveOfficialCodexRun` — cancels the active exact turn.
- `aiflow.runOfficialCodexProbe` and `aiflow.cancelOfficialCodexProbe` — preserved Phase 1
  compatibility surfaces, routed through the same service and worker.

Programmatic callers provide:

```ts
interface OfficialCodexRunRequest {
  runId: string; // UUID
  workspacePath: string; // absolute, canonical path matching the sole open workspace
  prompt: string; // exact input, non-blank, at most 128 KiB UTF-8
  modelRole: "luna" | "terra" | "sol";
  reasoningEffort: "low" | "medium" | "high" | "xhigh";
}
```

The result contract is:

```ts
interface OfficialCodexRunResult {
  runId: string;
  conversationId: string;
  turnId: string;
  outcome: "completed" | "failed" | "cancelled";
  finalResponse: string;
  requestedModelRole: "luna" | "terra" | "sol";
  requestedModelId: string;
  requestedReasoningEffort: "low" | "medium" | "high" | "xhigh";
  recordedModelId: string | null;
  recordedReasoningEffort: string | null;
  startedAt: string;
  finishedAt: string;
}
```

## Local validation

```sh
cd /Users/mayankdhingra/Desktop/aiflow-v2
npm install
npm run compile
npm test
```

Automated tests use local session fixtures and injected mocks for VS Code, clipboard, UI, the
shared service, and IPC. They do not import a live VS Code runtime, connect to Codex IPC, run the
live probe, or send a real model turn.

## Phase 2 live acceptance procedure

Do not run this procedure from automated tests. In a terminal, create a clean disposable Git
repository outside this source workspace and commit its initial README:

```sh
probe_dir="$(mktemp -d /tmp/aiflow-phase2.XXXXXX)"
git -C "$probe_dir" init
printf 'phase 2 acceptance workspace\n' > "$probe_dir/README.txt"
git -C "$probe_dir" add README.txt
git -C "$probe_dir" commit -m 'Initialize acceptance workspace'
printf 'Disposable repository: %s\n' "$probe_dir"
```

From the `aiflow-v2` VS Code window, confirm `openai.chatgpt` is exactly version `26.814.41407`,
press `F5`, and open the disposable repository only in the Extension Development Host. It must be
the only workspace folder.

Copy this exact prompt to the clipboard:

```text
Create phase2-proof.txt with bytes exactly equal to: phase 2 verified
Modify no other file.
```

Run **Aiflow: Run Clipboard Prompt Through Official Codex**. Select a model role and reasoning
effort, confirm the modal details (workspace, resolved model ID, reasoning, and UTF-8 prompt byte
count), and explicitly choose **Run**. In the Aiflow output require a run ID, workspace, selected
role and model ID, reasoning, conversation ID, turn ID, recorded settings, completed outcome, and
timestamps. Verify:

```sh
printf 'phase 2 verified' | cmp -s - "$probe_dir/phase2-proof.txt"
git -C "$probe_dir" status --short
```

The file must have bytes exactly `phase 2 verified` and status must show only
`?? phase2-proof.txt`. Run a second clipboard request and immediately run
**Aiflow: Cancel Active Official Codex Run**. The output must report a queued or confirmed exact
turn cancellation; it must not affect another conversation.
