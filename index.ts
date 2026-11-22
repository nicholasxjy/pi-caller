import { CustomEditor, type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { listPeers, openPeer, runtimeDirectory, sendTo, sessionLabel } from "./transport.ts";

const extension = "pi-caller";

function showSessionLabel(ui: ExtensionUIContext, label: string) {
	const previous = ui.getEditorComponent();
	const badge = ` ${label} `;
	const rightBorder = "──";
	const reserve = badge.length + rightBorder.length;
	const requiredBorder = "─".repeat(reserve + 1);

	ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = previous?.(tui, theme, keybindings)
			?? new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
		const render = editor.render.bind(editor);
		editor.render = (width) => {
			const lines = render(width);
			const top = lines[0];
			if (!top || !stripTerminalSequences(top).endsWith(requiredBorder)) return lines;

			const suffix = `\x1b[7m${badge}\x1b[27m${rightBorder}`;
			const styled = editor.borderColor?.(suffix) ?? theme.borderColor(suffix);
			return [truncateToWidth(top, width - reserve, "") + styled, ...lines.slice(1)];
		};
		return editor;
	});
}

export default function piCaller(pi: ExtensionAPI) {
	let local: { label: string; directory: string; close: () => Promise<void> } | undefined;
	let unavailable = "Pi Caller is starting.";

	pi.on("session_start", async (_event, ctx) => {
		let label: string;
		try {
			const directory = await runtimeDirectory();
			label = await sessionLabel(ctx.sessionManager.getSessionId());
			const close = await openPeer(directory, { label, cwd: ctx.cwd }, ({ from, text }) => {
				pi.sendMessage({
					customType: extension,
					display: true,
					content: `Message from Pi session ${from}:\n\n${text}`,
					details: { from },
				}, { triggerTurn: true, deliverAs: "followUp" });
			});
			local = { label, directory, close };
		} catch (error) {
			unavailable = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(unavailable, "warning");
			return;
		}
		showSessionLabel(ctx.ui, label);
	});

	pi.on("session_shutdown", async () => {
		const current = local;
		local = undefined;
		unavailable = "Pi Caller is closing.";
		await current?.close();
	});

	function currentPeer() {
		if (!local) throw new Error(unavailable);
		return local;
	}

	async function sessions() {
		const current = currentPeer();
		return (await listPeers(current.directory)).map((peer) => ({ ...peer, self: peer.label === current.label }));
	}

	function describeSessions(peers: Awaited<ReturnType<typeof sessions>>): string {
		return peers.map(({ label, cwd, self }) => `${label}${self ? " (you)" : ""}  ${cwd}`).join("\n");
	}

	async function send(to: string, text: string) {
		const current = currentPeer();
		const label = await sendTo(current.directory, to, { from: current.label, text });
		return `Accepted by Pi session ${label}.`;
	}

	pi.registerCommand("sessions", {
		description: "List online Pi Caller sessions and their labels",
		async handler(_args, ctx) {
			try {
				ctx.ui.notify(describeSessions(await sessions()), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("send", {
		description: "Send a message to an online Pi session: /send <label> <message>",
		async handler(args, ctx) {
			const match = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
			if (!match) {
				ctx.ui.notify("Usage: /send <label> <message>", "warning");
				return;
			}
			try {
				ctx.ui.notify(await send(match[1], match[2]), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "pi_caller_list",
		label: "List Pi sessions",
		description: "List online local Pi sessions, their labels, and working directories. Use a label with pi_caller_send.",
		promptSnippet: "Find online Pi sessions and their labels",
		promptGuidelines: ["Use pi_caller_list to find a recipient when the user asks to send a message without specifying a session label."],
		parameters: Type.Object({}),
		async execute() {
			const peers = await sessions();
			return { content: [{ type: "text", text: describeSessions(peers) }], details: { peers } };
		},
	});

	pi.registerTool({
		name: "pi_caller_send",
		label: "Send to Pi session",
		description: "Send text directly to an online local Pi session. The receiving agent will process it when idle.",
		promptSnippet: "Send a message directly to another Pi session by label",
		promptGuidelines: [
			"When the user asks to send or forward content to a Pi session and provides its label or prefix, call pi_caller_send directly with that label as to and the requested content as text.",
			"Use pi_caller_send with the sender label shown on an incoming Pi Caller message when asked to reply to it.",
		],
		parameters: Type.Object({
			to: Type.String({ description: "Recipient's Pi session label (e.g. ABC-1) or unambiguous prefix" }),
			text: Type.String({ description: "The content to deliver to the recipient" }),
		}),
		async execute(_id, { to, text }) {
			return { content: [{ type: "text", text: await send(to, text) }], details: {} };
		},
	});
}
