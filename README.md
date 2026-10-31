# AnLe

AnLe is a local terminal console that connects existing Codex CLI sessions and a human participant in shared workspaces. A repository can have multiple sessions, and a session can belong to multiple workspaces. The default view uses tmux to show the workspace beside the native Codex CLI. The name comes from An, the cream-colored dog, and Le, the black-and-silver dog.

```text
 ▛──────────────────────────────▜▛─────────────────────────────────────────▜
 │ ▄▀▀▄      █     ▄▄           ││  >_ OpenAI Codex                       │
 │ █▄▄█ █▀▀▄ █    █▄▄█          ││                                         │
 │ █  █ █  █ █▄▄▄ ▀▄▄▄          ││                                         │
 │ ──────────────────────────── ││                                         │
 │ human / inbox          1 NEW ││                                         │
 │ /Users/me/frontend           ││  The original Codex CLI session         │
 │ front                   IDLE ││                                         │
 │ /Users/me/backend            ││                                         │
 │ api                     BUSY ││                                         │
 │ ^A add  ^N inbox  ^P help    ││  › Ask Codex to do anything             │
 ▙──────────────────────────────▟▙─────────────────────────────────────────▟
 ── ■ FOCUSED ───────────────────┴── □ INACTIVE ──────────────────────────
```

## Getting started

You need Node.js 24 or later, a signed-in Codex CLI, tmux, and a terminal that can display Unicode block characters. This prototype was tested on macOS with Codex CLI 0.165.0 and its shared local app-server. If tmux is unavailable, AnLe opens its classic view instead.

```bash
npm install
npm start
```

When installed or linked as a command, use `anle`. The `serein` command remains available as a compatibility alias.

If AnLe cannot connect, open a normal `codex` session in another terminal, then press `Ctrl+R` in the console.

On first use, press `Ctrl+S` to connect AnLe MCP. This adds `mcp_servers.serein` to `~/.codex/config.toml` and sets its tools to be allowed automatically, so **sessions registered in a workspace** can exchange messages. AnLe then asks the shared app-server to refresh its MCP configuration. You can also run `npm run setup` from the project directory. An unrelated existing MCP server named `serein` will not be overwritten.

## Basic workflow

1. Open the Codex CLI sessions you want to connect in their respective repositories.
2. Press `Ctrl+A` in AnLe, select an existing session, and give the node a name and role. Press `/` to search sessions by name, directory, or ID. Sessions already in the workspace are marked `ADDED`. AnLe creates a dedicated `<name> CR` reviewer and queues an introduction in the original session.
3. Add the other sessions. You are the `human` participant in the workspace.
4. Click a session in the sidebar, or focus it and use the arrow keys or mouse wheel. Its native Codex CLI opens on the right; press `Enter` or `F7` to focus it, or start typing to send the first character and focus it automatically. Use the CLI's normal input, slash commands, approval prompts, and scrolling. Click the sidebar or press `F6` to return to it.
5. Click `human / inbox` to see messages from all workspaces in the main panel. Each message shows its workspace, and a reply returns to the original sender in that workspace. An and Le's little pixel animation stays in the inbox and message details. Select a message, type your reply in the visible input, and press `Enter` to send it. Press `Enter` with an empty input to open the full message. `Ctrl+N` opens the inbox and selects the newest unread message.
6. In an original Codex session, you can also ask an agent to find and contact another workspace member directly.

The highlighted `FOCUSED` label below a column shows where keyboard input will go; it follows mouse clicks and keyboard focus changes. The sidebar and the `Ctrl+A` session picker show each session's full working directory above its name. The selected CR session's path and name are red; other selected nodes are blue. Long paths wrap onto additional lines; sessions from the same directory remain separate entries. Use `Page Up` / `Page Down` to scroll through a list or path that exceeds the available height. Pressing `Ctrl+T` in the sidebar forwards it to the selected native session and focuses that pane.

Select an agent in the sidebar and press `Ctrl+O` to inspect its role, directory, reported task and status, and the time it last updated that report. `Ctrl+E` edits its name and role. Agents update their own task and status through `update_presence`; the information is self-reported and may be out of date. The separate Codex status is the last observation made by the running console; after 20 seconds without a refresh, discovery reports it as unknown.

The inbox shows unread and open counts across workspaces. Reading a message does not mark it answered. With the inbox focused, `Ctrl+T` filters to open messages; `Ctrl+D` marks the selected message done or undoes that action. Questions with an explicit reply request show `NEEDS REPLY`; older messages and messages without a stated expectation show `UNREPLIED` until answered or marked done. Informational updates can be sent without requesting a reply.

From the sidebar, `Ctrl+V` opens the current workspace's activity in the right pane, including delivery and reply status. Press `Ctrl+T` from either pane to group related messages into conversations; select one and press `Enter` to inspect its timeline. In the activity or timeline view, `Ctrl+O` opens the selected message's sender and `Ctrl+P` opens its recipient in the native session. Press `Esc` to return from a timeline, or `F6` and `Ctrl+V` to return to the selected session. `Ctrl+U` enables or disables optional desktop alerts for newly received human messages while AnLe is running. Alerts are off by default and the preference is stored locally. macOS uses Notification Center; Linux requires `notify-send`. Alerts do not run after AnLe exits.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Select a node in the sidebar or a message in the inbox |
| `Enter` / type | Focus the selected native Codex session / type directly into it |
| `F6` / `F7` | Focus the workspace sidebar / the Codex pane |
| `Tab` / `Esc` | Change focus or close a message within the sidebar |
| `Ctrl+N` / `Ctrl+V` | Open your inbox / switch between the selected node and collaboration activity |
| `Ctrl+O` | In the sidebar: inspect the selected agent's profile |
| `Ctrl+T` / `Enter` | In activity: toggle conversation groups / open the selected timeline |
| `Ctrl+O` / `Ctrl+P` | In activity: open the selected message's sender / recipient |
| `Ctrl+T` / `Ctrl+D` | In the inbox: filter open messages / mark the selected message done or undo |
| `Ctrl+U` | Toggle desktop alerts from the sidebar |
| `Page Up` / `Page Down` | Scroll within the focused Codex session or message |
| `Ctrl+A` | Add a session |
| `Ctrl+E` / `Ctrl+L` / `Ctrl+X` | Edit a node / resend its introduction / remove it |
| `Ctrl+K` / `Ctrl+Y` | Start or continue a review / edit this workspace's review rules |
| `Ctrl+G` / `Ctrl+W` | Switch / create a workspace |
| `Ctrl+D` | In the sidebar: delete the current workspace after confirmation |
| `Ctrl+S` | Connect or update the local AnLe MCP configuration |
| `Ctrl+R` / `Ctrl+P` / `Ctrl+Q` | Refresh or reconnect / help / quit |

To remove a session, select it and press `Ctrl+X`. Removing a coding node also removes its paired CR from that workspace; removing the CR alone disables its pairing. Select the coding node and press `Ctrl+L` to create a CR again. Both original Codex sessions remain intact. To delete a whole workspace, switch to it with `Ctrl+G`, press `Ctrl+D`, review the confirmation, and press `Y`. Deleting a workspace removes its AnLe membership and message records, while leaving the original Codex sessions and repositories intact. If it was the last workspace, AnLe creates a new empty one.

## Independent code review

Each coding session gets one dedicated `<name> CR` session in each workspace it joins. AnLe also creates missing pairs for existing members when the console is running and MCP is connected. Creating the session does not start a model turn. If the CR is offline, AnLe resumes it when a message is sent. Select either node to see its original native Codex CLI.

The coding agent's introduction tells it to discover its CR with `list_members` and request review with `send_message` after meaningful code changes. The request includes project background, requirements, the base branch/ref, development branch/ref, scope and checks. The agent should mark an unknown branch as unknown rather than guess; the CR asks for missing context. The CR checks correctness, regressions, tests, project conventions, and whether existing code can be reused. It reports every outcome to the coding agent through the normal message channel, including when it finds no issues. Only a question requiring a human decision goes to the human inbox. The coding agent can fix valid findings and request a re-review in the same conversation. The built-in guidance limits the automatic workflow to an initial review and one re-review before involving the human.

This is an agent-guided workflow, not a Git hook or a guaranteed merge gate: the coding agent decides whether a change needs review, and a `QUEUED` message does not prove that review completed. Review is advisory and the CR is started with a read-only sandbox. It does not modify your repository, commit, or merge. The CR normally inspects the live repository; it should report if the working tree changed during review. Changes from other sessions in the same worktree may also be visible.

Press `Ctrl+S` once after updating AnLe to reload its MCP tools. AnLe sends the paired introduction automatically when each coding session is online. If an existing session cannot see the new tools, reopen it and use `Ctrl+L` to resend the introduction. You can set workspace-specific review rules with `Ctrl+Y`, for example `Prefer existing auth helpers and follow API error conventions`. `Ctrl+O` shows a node's pairing status. A failed pairing can be retried with `Ctrl+L`; if creation or delivery is `UNKNOWN`, inspect the existing sessions or Activity before retrying.

The coding agent normally provides context using the optional `review_context` object of `send_message`: `project_background`, `base_branch`, and `development_branch`. These details are part of the visible message. For follow-up requests, `reply_message` keeps the same conversation and the same CR's history.

The CR can include `human_question` in its reply only when a human decision is needed. If a review turn ends without sending a result, AnLe relays the CR's final response to the coding session, or explicitly reports that the review did not finish; it does not infer that an unreported review passed. Monitoring runs while the console or a relevant AnLe MCP server is running and resumes when the console reopens.

### Optional snapshot review

For a fixed review target and tracked finding IDs, select a coding session or its CR and press `Ctrl+K`. Enter the goal, Git base ref and optional paths. AnLe uses the same dedicated CR and creates an isolated read-only snapshot. Results are delivered to the coding session with finding IDs and freshness; a question goes to the inbox only when a human decision is needed. After changes, use `Ctrl+K`, then `R` to review another snapshot in the same CR session; each previously open finding must be marked open, resolved, or dismissed with a reason. `N` starts a separate review task with a new goal or scope.

The default base, `HEAD`, includes staged, unstaged, and non-ignored untracked files. To include already committed work, provide an earlier commit or branch as the base. The snapshot contains **all** changes in the selected paths, including changes made by other sessions sharing that working tree; AnLe cannot reliably attribute them to one agent. Working-tree changes outside an explicit path selection are not copied, so leave the scope blank when the review depends on changes in several directories. UI and CLI path lists use commas as separators; the MCP tool accepts an array for paths that themselves contain commas.

The reviewer reads project files, including relevant in-repository `AGENTS.md` and `REVIEW.md` files. It receives your review goal, workspace rules, the change scope, and any collaboration message explicitly linked by the requesting agent; it does not automatically receive the development session's entire conversation. Put the acceptance criteria and important decisions in the goal or linked message. Instructions stored in directories outside the repository may not be inherited by the snapshot; put any relevant rules in the workspace review rules.

Automated rounds always use their own snapshot. An already-open native reviewer pane may keep its original working directory; for a manual follow-up, ask the reviewer to use the latest snapshot path from `get_review`, or restart AnLe before reopening that pane.

Snapshot review requires a Git repository with at least one commit. Selected paths cannot contain unresolved merge conflicts or submodules. Ignored files and installed dependencies are not copied, so some checks may be unavailable; the reviewer reports that limitation. A snapshot accepts patches up to 64 MB and up to 32 MB of untracked files. Large repositories may take time and disk space to copy. If the working tree changes while it is being captured, retry the request.

Snapshots and review records are stored locally under `~/.serein` (or `SEREIN_HOME`), in `reviews/<review-id>/round-<n>/<attempt-id>/repo`. Snapshots contain copies of source code and Git history and are retained even when a workspace is deleted, because a Codex session may still be using them. Once the associated review sessions are finished, you may delete those snapshot directories yourself. Review results can be `UNKNOWN` if a start or delivery was interrupted; inspect the reviewer session and Activity before trying again. If the console is closed, a successful reviewer can still submit its result; detection of a reviewer that exits without submitting resumes when the console is opened again. Starting review sessions consumes Codex usage.

For agent integrations, AnLe exposes `request_review`, `list_reviews`, `get_review`, and `submit_review` over MCP. A developer can pass `context_message_id` when the requirement is in a collaboration message it sent or received. The equivalent commands, run from a registered Codex session, are:

```bash
anle review --goal "Review login behavior and reuse of existing auth helpers" --base main --paths src/auth,test/auth
anle reviews
anle review-info --review-id REVIEW_ID
anle review --review-id REVIEW_ID
```

## How messaging works

The AnLe MCP server exposes `list_members`, `update_presence`, `send_message`, `reply_message`, `get_message_status`, and `get_conversation`. Codex supplies the calling session ID in MCP metadata, and AnLe only allows sessions registered in that workspace to use these tools. `list_members` includes each agent's role, directory, self-reported task and task status, update time, and last observed Codex status. `update_presence` changes only the calling agent's report.

An agent can continue working after it sends a message; a reply is queued in its original session. Agents can set `reply_expected` for questions or informational updates; if omitted, the expectation remains unspecified. A direct reply automatically stays in the original conversation. When asking another participant about an existing message, the agent passes that message's ID as `context_message_id` so the new question joins the same conversation. Only messages explicitly linked this way are grouped; unrelated messages are not inferred to be related. The console shows the whole workspace conversation, while `get_conversation` returns only messages sent or received by the calling session. Status lookup is limited to the message's sender and recipient.

The equivalent CLI commands include `anle presence --task "Implementing login" --status working`, `anle send --to human --message "Which policy?" --context-message MESSAGE_ID --reply-expected true`, and `anle conversation --message-id MESSAGE_ID`. Run them from a registered Codex session, with `CODEX_THREAD_ID` identifying that session.

Messages to an agent are delivered through `codex queue` and appear as inputs marked `[AnLe · …]` in the original CLI session. The sender also shows the message and tool call in its session. Each session continues to follow its own instructions and permissions when handling another agent's message.

**QUEUED** means Codex accepted the message; it does not mean the recipient has read or processed it. **REPLIED** means a correlated reply was delivered to the human inbox or accepted into the other session's queue; it does not mean that reply has been read. **FAILED** and **UNKNOWN** remain visible. An interrupted send whose outcome cannot be established becomes `UNKNOWN`, and AnLe does not automatically resend it. Questions and messages with an unspecified reply expectation remain open until they are answered or marked done, independently of their unread state.

## Current scope

- Delivery is limited to sessions connected to the same shared app-server. AnLe automatically resumes a paired CR when sending to it; other **OFFLINE** sessions must be opened before they can receive queued messages. Sessions using `--no-daemon` or a separate app-server are outside this scope.
- If an existing session does not see the AnLe tools after setup, reopen it, select its node in the console, and press `Ctrl+L` to resend the introduction.
- Workspaces, members, messages, and inbox read markers are stored locally in `~/.serein/serein.sqlite`. Set `SEREIN_HOME` to use another data directory, and use the same value for setup and the console.
- The native pane is a separate Codex CLI client rejoining the same shared app-server session. Existing CLI windows remain open; messages and turns belong to the same session. Each selected session keeps its own pane and unsent input when you switch away. Codex controls the native display, including whether tool activity appears.
- Run `npm start -- classic` for the non-tmux view. It displays user messages and agent replies without tool calls, has a scrollbar with mouse-wheel and drag support, and queues its inline input as AnLe messages.
- Exiting the console does not remove workspaces or messages. Sessions with MCP configured can continue to communicate. To remove the integration, run `codex mcp remove serein` and reload the affected Codex sessions.
- Messages are collaboration requests. Each agent decides how to act based on its current task, context, and permissions. Sending messages consumes Codex usage.

## Testing

```bash
npm test
```

The automated tests cover native pane switching, mouse and keyboard navigation, agent presence, conversation linking and navigation, cross-workspace inbox replies, message delivery and reply states, optional notification settings, history pagination, filtered conversation rendering, scrollbar interaction, inline text editing, and identification of the calling session from MCP metadata. Review tests exercise snapshot capture, native reviewer navigation, MCP submission, finding history, freshness, retries, and recovery from uncertain delivery using isolated repositories and a simulated Codex server.

The original An and Le pet artwork is preserved in `assets/an-le-pixel.png`. Run `python3 scripts/build-pet-art.py` to regenerate its terminal color grids; the console does not need Python at runtime.
