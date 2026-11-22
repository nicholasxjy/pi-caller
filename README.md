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

The agent calls `pi_caller_send` with the label and message. You can also ask it to list the online sessions or reply to the sender of a Pi Caller message.

The status bar shows your session's full label. It consists of three uppercase letters, a hyphen, and one digit from 0 to 9. To send from the Pi command line, use `/sessions` to list online sessions and `/send <label> <message>` to send. You can also use an unambiguous label prefix.

The receiving Pi shows the sender's label and starts a turn when idle. If the agent is busy, Pi queues the message as a follow-up. A send confirmation means that the receiving process accepted the message for Pi. The recipient can send a reply to the sender's label.

Labels are reserved locally in `~/.pi/pi-caller-labels`. A session keeps its label on resume and reload. New and forked sessions get new labels. After upgrading from UUID-based labels, reload all participating sessions and use their new labels. If two Pi processes open the same saved session, only the first can use Pi Caller. Once it exits, run `/reload` in the other process to register there. Sending to a closed session returns an error.

The extension follows [pi-fabric](https://github.com/fabric-runtime/pi-fabric)'s approach of discovering live sessions and confirming acceptance on the receiving side. Pi Caller uses private local Unix sockets and accepts text payloads of up to 64 KiB, including sender metadata.

## Test

Run `npm test` on Node.js 22.19 or later.
