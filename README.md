# Pi Caller

Pi Caller lets Pi coding agent sessions on the same macOS or Linux machine send each other messages under the same system account, including sessions in different working directories. It requires no separate service.

## Install

With Pi 1.6 or later, run this from a checkout to install the extension for all your sessions.

```sh
pi install .
```

Open two Pi sessions. In a session that is already running, use `/reload` to load the newly installed extension. To try it for one invocation, run `pi -e ./index.ts` from the checkout.

## Send a message

Paste a recipient's label into a regular prompt to have your agent send the message directly.

> Send “The tests passed. You can continue.” to Pi session `ABC-1`.

The agent calls `pi_caller_send` with the label and message. You can also ask it to list the online Pi sessions or reply to the sender of a Pi Caller message. When you address a subagent in the current session, the agent uses its subagent tools, even if the recipient's name looks like a Pi Caller label.

The upper-right corner of the input box shows your session's full label. It consists of three uppercase letters, a hyphen, and one digit from 0 to 9. When the terminal top border has too little space (for example, on narrow screens or while a long working status is embedded), the label falls back to the bottom status bar and returns to the border once space is available.

To send from the Pi command line, use `/sessions` to list online sessions (including session names and `[busy]` status when available) and `/send <label> <message>` to send. `/send` supports Tab completion for online recipient labels, and you can also use an unambiguous label prefix. Sending to the current session is rejected, and prefix matching excludes the current session automatically.

The receiving Pi shows the sender's label and starts a turn when idle. If the agent is busy, Pi queues the message as a follow-up. A send confirmation means that the receiving process accepted the message for Pi. The recipient can send a reply to the sender's label.

Pi Caller listens only in long-lived `tui` and `rpc` sessions (`print` and `json` runs skip registration). Persistent sessions reserve labels locally in `~/.pi/pi-caller-labels` and keep them across resume and reload, while new, forked, and `--no-session` ephemeral sessions receive distinct labels without polluting the saved label directory. If two Pi processes open the same saved session, only the first can use Pi Caller; once it exits, run `/reload` in the other process to register there. Stale registrations and dead socket files from crashed sessions are cleaned up automatically.

The extension follows [pi-fabric](https://github.com/fabric-runtime/pi-fabric)'s approach of discovering live sessions and confirming acceptance on the receiving side. Pi Caller uses private local Unix sockets and accepts text payloads of up to 64 KiB, including sender metadata.

## Test

Run `npm test` on Node.js 22.19 or later (no `npm install` required).
