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
		label: "List Pi Caller sessions",
		description: "List the labels and working directories of online Pi Caller sessions when the user asks to list or contact a separate local Pi session.",
		promptSnippet: "Look up Pi Caller labels for separate local Pi sessions",
		promptGuidelines: ["Use pi_caller_list only when the user asks to list online Pi sessions or wants to contact a separate Pi session and needs its label."],
		parameters: Type.Object({}),
		async execute() {
			const peers = await sessions();
			return { content: [{ type: "text", text: describeSessions(peers) }], details: { peers } };
		},
	});

	pi.registerTool({
		name: "pi_caller_send",
		label: "Send to Pi session",
		description: "Deliver a user-requested message to a separate, already running local Pi session by its Pi Caller label or unique prefix. Use the subagent tools for messages to subagents in the current session.",
		promptSnippet: "Deliver a cross-session message by Pi Caller label",
		promptGuidelines: [
			"Use pi_caller_send directly for a message addressed to a separate Pi session by label or prefix. When the user asks to reply to a Pi Caller message, use its sender label.",
			"Use the available subagent tools to start, steer, resume, or get results from a subagent, even when its name looks like a Pi Caller label. Reserve pi_caller_list and pi_caller_send for requests about separate Pi sessions.",
		],
		parameters: Type.Object({
			to: Type.String({ description: "Pi Caller label of the destination session (e.g. ABC-1) or an unambiguous prefix" }),
			text: Type.String({ description: "The content to deliver to the recipient" }),
		}),
		async execute(_id, { to, text }) {
			return { content: [{ type: "text", text: await send(to, text) }], details: {} };
		},
	});
}
