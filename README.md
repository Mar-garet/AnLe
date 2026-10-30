# AnLe

AnLe is a local terminal console that connects existing Codex CLI sessions and a human participant in shared workspaces. A repository can have multiple sessions, and a session can belong to multiple workspaces. The default view uses tmux to show the workspace beside the native Codex CLI. The name comes from An, the cream-colored dog, and Le, the black-and-silver dog.

```text
 ┌──────────────────────────────┐┌─────────────────────────────────────────┐
 │ ▄▀▀▄      █     ▄▄           ││  >_ OpenAI Codex                       │
 │ █▄▄█ █▀▀▄ █    █▄▄█          ││                                         │
 │ █  █ █  █ █▄▄▄ ▀▄▄▄          ││                                         │
 │ ──────────────────────────── ││                                         │
 │ human / inbox          1 NEW ││                                         │
 │ /Users/me/frontend           ││  The original Codex CLI session         │
 │ front                   IDLE ││                                         │
 │ /Users/me/backend            ││                                         │
 │ api                     BUSY ││                                         │
 │ F6 list · F7 Codex           ││  › Ask Codex to do anything             │
 └──────────────────────────────┘└─────────────────────────────────────────┘
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
2. Press `Ctrl+A` in AnLe, select an existing session, and give the node a name and role. Press `/` to search sessions by name, directory, or ID. Sessions already in the workspace are marked `ADDED`. Joining queues an introduction in the original session.
3. Add the other sessions. You are the `human` participant in the workspace.
4. Click a session in the sidebar, or focus it and use the arrow keys or mouse wheel. Its native Codex CLI opens on the right; press `Enter` or `F7` to focus it, or start typing to send the first character and focus it automatically. Use the CLI's normal input, slash commands, approval prompts, and scrolling. Click the sidebar or press `F6` to return to it.
5. Click `human / inbox` to see your messages in the main panel. An and Le stay visible alongside the inbox and message details, using smaller portraits when the pane is narrow. Select a message, type your reply in the visible input, and press `Enter` to send it to that agent. You can start typing with the sidebar focused; the input moves to the inbox automatically. Press `Enter` with an empty input to open the full message. `Ctrl+N` also opens the inbox from the sidebar.
6. In an original Codex session, you can also ask an agent to find and contact another workspace member directly.

The sidebar and the `Ctrl+A` session picker show each session's full working directory above its name. Paths are highlighted, with the selected session's path in a different color. Long paths wrap onto additional lines; sessions from the same directory remain separate entries. Use `Page Up` / `Page Down` to scroll through a list or path that exceeds the available height.

| Key | Action |
| --- | --- |
| `↑` / `↓` | Select a node in the sidebar or a message in the inbox |
| `Enter` / type | Focus the selected native Codex session / type directly into it |
| `F6` / `F7` | Focus the workspace sidebar / the Codex pane |
| `Tab` / `Esc` | Change focus or close a message within the sidebar |
| `Ctrl+N` / `Ctrl+V` | Open your inbox / switch between the selected node and collaboration activity |
| `Page Up` / `Page Down` | Scroll within the focused Codex session or message |
| `Ctrl+A` | Add a session |
| `Ctrl+E` / `Ctrl+L` / `Ctrl+X` | Edit a node / resend its introduction / remove it |
| `Ctrl+G` / `Ctrl+W` | Switch / create a workspace |
| `Ctrl+D` | Delete the current workspace after confirmation |
| `Ctrl+S` | Connect or update the local AnLe MCP configuration |
| `Ctrl+R` / `Ctrl+P` / `Ctrl+Q` | Refresh or reconnect / help / quit |

To remove just one session, select it and press `Ctrl+X`. To delete a whole workspace, switch to it with `Ctrl+G`, press `Ctrl+D`, review the confirmation, and press `Y`. Deleting a workspace removes its AnLe membership and message records, while leaving the original Codex sessions and repositories intact. If it was the last workspace, AnLe creates a new empty one.

## How messaging works

The AnLe MCP server exposes `list_members`, `send_message`, and `reply_message`. Codex supplies the calling session ID in MCP metadata, and AnLe only allows sessions registered in that workspace to use these tools. An agent can continue working after it sends a message; a reply is queued in its original session.

Messages to an agent are delivered through `codex queue` and appear as inputs marked `[AnLe · …]` in the original CLI session. The sender also shows the message and tool call in its session. Each session continues to follow its own instructions and permissions when handling another agent's message.

**QUEUED** means Codex accepted the message; it does not mean the recipient has processed or answered it. Messages to `human` appear in the inbox, with an unread count that remains until you open or reply to them. Failed or uncertain deliveries remain in the message history.

## Current scope

- Delivery is limited to sessions connected to the same shared app-server. Selecting a saved session in the native view rejoins it through that server; an **OFFLINE** session must be opened before it can receive queued messages. Sessions using `--no-daemon` or a separate app-server are outside this scope.
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

The automated tests cover native pane switching, mouse and keyboard navigation, inbox replies to the selected agent, history pagination, filtered conversation rendering, scrollbar interaction, inline text editing, inbox read markers, message routing, delivery failures, and identification of the calling session from MCP metadata.

The pet sprite source is `assets/an-le-pixel.png`. Run `python3 scripts/build-pet-art.py` to regenerate its terminal color grids; the console does not need Python at runtime.
