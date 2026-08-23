# Aiflow reusable official Codex worker

Phase 1 live acceptance passed for the pinned official VS Code extension. Phase 2 turns that
accepted bootstrap and exact-turn correlation into one app-lifetime worker and execution service.
Phase 3 adds Git delivery evidence around that same worker; Aiflow verifies delivery but never
creates an implementation commit or pushes a target repository itself.

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
- `aiflow.runGitImplementation` — internal programmatic Git-delivery workflow; not shown in the
  Command Palette.
- `aiflow.runClipboardGitImplementation` — visible **Aiflow: Run Clipboard Implementation and
  Verify Git Delivery** workflow.
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

## Phase 3 Git delivery evidence

`GitImplementationRunRequest` extends the Phase 2 request with a conservative `owner/repository`
identity, expected branch, and full expected base object ID. Before any official-extension bootstrap
or real turn, the Git workflow canonicalizes the one workspace, requires that it is the repository
root and is clean (including untracked files), rejects detached HEAD, and validates the exact branch,
base SHA, upstream, and safe GitHub repository identity. GitHub HTTPS and `git@github.com:` URLs are
recognized; raw remote URLs are never put in results, errors, logs, or review envelopes.

All Git commands are trusted fixed argument arrays run with `execFile`, no shell, bounded output and
timeouts. Aiflow never accepts shell text, Git commands, remote URLs, or paths from Codex output. It
does not clean, stash, checkout, reset, fetch, pull, commit, or push the target repository.

After the worker reaches a terminal outcome, Aiflow independently reads the branch, ancestry, commits
after the base (at most 100), worktree status, upstream identity, and the exact remote branch SHA via
read-only `git ls-remote`. A remote-tracking ref is never used as the sole push proof.

Remote proof is the final gate. Aiflow first classifies completed runs from local evidence in the
documented order (repository, branch, ancestry, commits, cleanliness, and immutable upstream). It
skips `git ls-remote` whenever one of those deterministic statuses is already known. Consequently, a
remote timeout or malformed response can produce `git_inspection_failed` only after every local gate
has passed; it can never replace a higher-precedence delivery status.

The preflight upstream target is immutable for the run: its remote name, upstream ref, and derived
`refs/heads/...` branch ref are retained separately. Postflight checks the currently configured
upstream only for integrity; it never redirects verification to a new upstream. Changing or removing
that configuration therefore cannot produce `verified`. The read-only remote query is issued only for
the original remote and original branch ref, and its output must be exactly one full object ID paired
with that exact ref. Empty output means no remote branch; malformed, duplicate, or mismatched output
is an inspection failure.

```ts
interface GitImplementationRunRequest extends OfficialCodexRunRequest {
  expectedGitHubRepository: string;
  expectedBranch: string;
  expectedBaseSha: string;
}

interface GitDeliveryEvidence {
  githubRepository: string;
  branch: string;
  baseSha: string;
  headSha: string;
  commitShas: string[];
  workingTreeClean: boolean;
  upstreamRemote: string;
  upstreamRef: string;
  remoteHeadSha: string | null;
  pushVerified: boolean;
}
```

Delivery status has deterministic precedence: `codex_not_completed`, `repository_mismatch`,
`branch_changed`, `history_rewritten`, `no_commit`, `working_tree_dirty`, and `push_not_verified`;
an inspection exception is `git_inspection_failed`. Otherwise the status is `verified`. Verification
requires a completed Codex result, matching repository and branch, preserved base ancestry, at least
one new commit, a clean tree, and a remote branch SHA exactly equal to local HEAD. A failed verification
does not redispatch Codex.

Expected integrity mismatches fail closed with their deterministic delivery status: detached or changed
branch is `branch_changed`, replacement history is `history_rewritten`, no new commit is `no_commit`,
dirty state is `working_tree_dirty`, repository identity drift is `repository_mismatch`, and changed
upstream or remote proof is `push_not_verified`. Only a real command timeout, malformed Git response,
or unreadable repository is `git_inspection_failed`.

The visible workflow reads the clipboard exactly, snapshots the clean Git state before model choices,
then shows a modal with repository, branch, short base SHA, selected model/ID and reasoning, UTF-8
prompt byte count, and an explicit statement that Aiflow verifies but does not commit or push. The
existing active-worker cancellation command remains the only cancellation path.

The result can be converted to deterministic JSON with `createImplementationReviewEnvelope()` and
`serializeImplementationReviewEnvelope()`. Its V1 envelope includes run/delivery/Git evidence and
Codex identifiers/settings/timestamps, but excludes workspace paths, remote URLs, credentials,
session content, and the submitted prompt.

Example (values abbreviated):

```json
{"version":1,"runId":"…","githubRepository":"owner/repository","branch":"main","baseSha":"…","headSha":"…","commitShas":["…"],"pushVerified":true,"deliveryStatus":"verified","codexOutcome":"completed","codexFinalResponse":"…","modelRole":"terra","modelId":"gpt-5.6-terra","reasoningEffort":"high","conversationId":"…","turnId":"…","startedAt":"…","finishedAt":"…"}
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
live probe, send a real model turn, or make a real GitHub network call.

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

## Phase 3 live acceptance procedure

Do not run this procedure from automated tests. Use a disposable GitHub repository with a clean
tracked base commit and an upstream branch. Open it as the only workspace folder in an Extension
Development Host, then use **Aiflow: Run Clipboard Implementation and Verify Git Delivery** with:

```text
Create phase3-proof.txt with bytes exactly equal to: phase 3 verified
Modify no other file except as required to run the requested validation.
Run the requested validation.
Commit the change.
Push the current branch.
Report the commit SHA.
```

Confirm the modal’s exact repository, branch, and base SHA before starting. Require one new commit,
a clean final worktree, remote branch SHA equal to local HEAD, delivery status `verified`, and a review
envelope naming the same repository and head SHA. In a second run, use the existing cancellation command
and verify it still targets only one exact turn. This integration is private and version-specific to
the pinned official Codex extension; the original preflight upstream branch remains the only verified
destination. Do not run live turns or GitHub network calls in automated tests.
