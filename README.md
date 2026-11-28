# Pi Caller

Send messages between local Pi coding agent sessions on macOS or Linux (same user, any working directory) over private Unix sockets—no separate service required.

## Install

Requires Pi 1.6 or later. Install from Git:

```sh
pi install git:github.com/nicholasxjy/pi-caller
```

Or via SSH / a local checkout:

```sh
pi install git:git@github.com:nicholasxjy/pi-caller
pi install .
```

Run `/reload` in already-running Pi sessions to load the extension, or test it once from a local clone with `pi -e ./index.ts`.

## Usage

Each active `tui` or `rpc` session is assigned a label like `ABC-1`, shown in the top-right input border (or the bottom status bar on narrow terminals).

### Via prompt

Mention a recipient's label in a regular prompt—the agent uses `pi_caller_send` (or `pi_caller_list` to view online sessions) while reserving subagent tools for in-session subagents:

> Send “The tests passed. You can continue.” to Pi session `ABC-1`.

### Via slash commands

- `/sessions` — list online sessions, working directories, session names, and `[busy]` status.
- `/send <label> <message>` — send directly with Tab completion and unambiguous label-prefix matching (excludes the current session).

### Behavior

- **Delivery**: Incoming messages display the sender's label, start a turn when idle, or queue as a follow-up when busy (text payloads up to 64 KiB including sender metadata).
- **Labels**: Persistent sessions keep their labels across resume and `/reload` (`~/.pi/pi-caller-labels`); new, forked, and `--no-session` ephemeral sessions get distinct labels.
- **Conflicts & cleanup**: Only the first process opening a saved session registers; once it exits, run `/reload` in another process to take over. Stale registrations and dead sockets are cleaned up automatically.
- **Design**: Follows [pi-fabric](https://github.com/fabric-runtime/pi-fabric)'s approach of discovering live sessions and confirming acceptance on the receiving side.

## Test

```sh
npm test
```

Requires Node.js 22.19 or later (no `npm install` needed).
