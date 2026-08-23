# Aiflow reusable official Codex worker

This repository contains a minimal VS Code companion-extension worker. It is pinned to the locally inspected official extension:

- Extension ID: `openai.chatgpt`
- Exact supported version: `26.814.41407`
- Supported model roles: `luna`, `terra`, `sol`
- Supported reasoning effort: `low`, `medium`, `high`, `xhigh`

The worker does not launch Codex CLI, Codex App Server, or any child process. It invokes the official extension's `chatgpt.implementTodo` command only for a nonce-only bootstrap, then sends the caller's exact prompt through the already-running official extension's private local IPC router.

Because this is a private, version-specific protocol probe, any other official-extension version is rejected before a model turn is started.

## Setup

Requirements:

- VS Code 1.96.2 or newer
- Node.js 22 or newer for local development
- Official `openai.chatgpt` extension version exactly `26.814.41407`
- A signed-in and working official Codex extension
- Exactly one local workspace folder open

Install and validate:

```sh
cd /Users/mayankdhingra/Desktop/aiflow-v2
npm install
npm run compile
npm test
```

These automated tests use local fixtures and injected or mocked IPC sockets. They do not run
the live probe and do not send a real Codex model turn.

## Manual F5 acceptance test

1. In a terminal, create a disposable Git repository outside this source workspace. Create it
   from the terminal only; do not open it in a separate normal VS Code window:

   ```sh
   probe_dir="$(mktemp -d /tmp/aiflow-official-probe.XXXXXX)"
   git -C "$probe_dir" init
   printf 'probe workspace\n' > "$probe_dir/README.txt"
   printf 'Disposable repository: %s\n' "$probe_dir"
   ```

2. In this repository's VS Code window, confirm the Extensions view reports `openai.chatgpt` version `26.814.41407`.
3. Press `F5` from the `aiflow-v2` window and select **Run Aiflow Probe Extension**.
4. Open the disposable repository for the first time only inside the Extension Development Host:
   use **File → Open Folder…**, enter the path printed in `probe_dir`, and ensure it is the only
   workspace folder.
5. Open the Command Palette and run **Aiflow: Run Official Codex Probe**.
6. Open **View → Output** and select **Aiflow Official Codex Probe**.
7. Within the bounded two-minute windows, require output containing:

   ```text
   extension version: 26.814.41407
   conversation ID: <non-empty>
   bootstrap turn ID: <non-empty>
   real turn ID: <non-empty>
   requested model: gpt-5.6-luna
   requested reasoning: low
   terminal outcome: completed
   final response: AIFLOW_PHASE2_ACCEPTANCE.
   probe state: completed
   ```

8. Confirm `git -C "$probe_dir" status --short` has no changes other than the intentionally untracked `README.txt` created before the probe.
9. Run the probe again and immediately run **Aiflow: Cancel Official Codex Probe**. The output must either say cancellation is queued until the exact real turn is known or confirm the exact real turn ID. The eventual terminal outcome must be `cancelled`; it must not stop any other Codex conversation.

## Confirmed private IPC contract

Messages use a four-byte little-endian payload length followed by UTF-8 JSON on `~/.codex/ipc/ipc.sock`.

| Method | Version | Request parameters | Successful result |
| --- | ---: | --- | --- |
| `initialize` | 0 | `{clientType:"vscode"}` | `{clientId}` |
| `thread-owner-discovery` | 1 | `{hostId:"local",conversationId}` | top-level `handledByClientId`, result `{}` |
| `thread-follower-update-thread-settings` | 1 | `{conversationId,threadSettings:{model,effort}}` | `{ok:true}` |
| `thread-follower-start-turn` | 1 | `{conversationId,turnStartParams,localTurnMetadata,mcpAppModelContextAttachments}` | `{result:{turn:{id}}}` when provided |
| `thread-follower-interrupt-turn` | 4 | `{conversationId,mode:"user-stop",expectedTurnId}` | `{ok:true,interruptedTurnId}` |

These shapes were confirmed against the installed `openai.chatgpt@26.814.41407` bundle and must not be treated as stable across versions.
