import type { CustomEditor, ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import type { Type as TypeBox } from "typebox";
import {
	ephemeralLabel,
	listPeers,
	openPeer,
	runtimeDirectory,
	sendTo,
	sessionLabel,
	type Peer,
} from "./transport.ts";

export const extension = "pi-caller";
const maxSessionNameLength = 60;

export interface PiCallerDeps {
	CustomEditor: new (
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		options?: { embedWorkingStatus?: boolean },
	) => CustomEditor;
	stripTerminalSequences: (text: string) => string;
	truncateToWidth: (text: string, width: number, ellipsis?: string) => string;
	Type: typeof TypeBox;
	runtimeDirectory?: () => Promise<string>;
	labelDirectory?: string;
}

export type ListedPeer = Peer & { self: boolean };

function normalizeSessionName(name?: string): string | undefined {
	if (!name) return undefined;
	const collapsed = name.replace(/\s+/g, " ").trim();
	if (!collapsed) return undefined;
	if (collapsed.length <= maxSessionNameLength) return collapsed;
	return `${collapsed.slice(0, maxSessionNameLength - 1)}…`;
}

export function describeSessions(peers: ListedPeer[]): string {
	if (peers.length === 0) return "No online Pi Caller sessions.";
	return peers.map(({ label, cwd, name, busy, self }) => {
		const tags = `${label}${self ? " (you)" : ""}${busy ? " [busy]" : ""}`;
		const cleanName = normalizeSessionName(name);
		return `${tags}  ${cwd}${cleanName ? `  — ${cleanName}` : ""}`;
	}).join("\n");
}

export function showSessionLabel(
	ui: ExtensionUIContext,
	label: string,
	deps: Pick<PiCallerDeps, "CustomEditor" | "stripTerminalSequences" | "truncateToWidth">,
	isActive: () => boolean = () => true,
) {
	const previous = ui.getEditorComponent();
	const badge = ` ${label} `;
	const rightBorder = "──";
	const reserve = badge.length + rightBorder.length;
	const requiredBorder = "─".repeat(reserve + 1);
	let fallbackShown: boolean | undefined;

	function syncFallback(needFallback: boolean) {
		if (fallbackShown === needFallback) return;
		fallbackShown = needFallback;
		queueMicrotask(() => {
			if (!isActive()) return;
			ui.setStatus(extension, needFallback ? label : undefined);
		});
	}

	ui.setEditorComponent((tui, theme, keybindings) => {
		const editor = previous?.(tui, theme, keybindings)
			?? new deps.CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
		const render = editor.render.bind(editor);
		editor.render = (width) => {
			const lines = render(width);
			const top = lines[0];
			if (!top || width <= reserve || !deps.stripTerminalSequences(top).endsWith(requiredBorder)) {
				syncFallback(true);
				return lines;
			}

			syncFallback(false);
			const suffix = `\x1b[7m${badge}\x1b[27m${rightBorder}`;
			const styled = editor.borderColor?.(suffix) ?? theme.borderColor(suffix);
			return [deps.truncateToWidth(top, width - reserve, "") + styled, ...lines.slice(1)];
		};
		return editor;
	});
}

export function createPiCaller(pi: ExtensionAPI, deps: PiCallerDeps) {
	let local: { label: string; directory: string; close: () => Promise<void> } | undefined;
	let unavailable = "Pi Caller is starting.";
	let generation = 0;
	let activeUi: ExtensionUIContext | undefined;

	const getRuntimeDirectory = deps.runtimeDirectory ?? runtimeDirectory;

	pi.on("session_start", async (_event, ctx) => {
		const currentGen = ++generation;
		const previous = local;
		local = undefined;
		activeUi?.setStatus(extension, undefined);
		activeUi = undefined;
		await previous?.close();

		if (currentGen !== generation) return;

		if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
			unavailable = `Pi Caller is disabled in ${ctx.mode} mode.`;
			return;
		}

		let label: string;
		try {
			const directory = await getRuntimeDirectory();
			if (currentGen !== generation) return;

			const sessionId = ctx.sessionManager.getSessionId();
			const persistent = Boolean(ctx.sessionManager.getSessionFile());

			const startPeer = (candidateLabel: string) =>
				openPeer(
					directory,
					() => ({
						label: candidateLabel,
						cwd: ctx.cwd,
						name: pi.getSessionName(),
						busy: !ctx.isIdle(),
					}),
					({ from, text }) => {
						pi.sendMessage({
							customType: extension,
							display: true,
							content: `Message from Pi session ${from}:\n\n${text}`,
							details: { from },
						}, { triggerTurn: true, deliverAs: "followUp" });
					},
				);

			let close: () => Promise<void>;
			if (persistent) {
				label = await sessionLabel(sessionId, deps.labelDirectory);
				if (currentGen !== generation) return;
				close = await startPeer(label);
			} else {
				const existingPeers = await listPeers(directory);
				if (currentGen !== generation) return;
				const taken = new Set(existingPeers.map((peer) => peer.label));
				for (;;) {
					label = ephemeralLabel(sessionId, taken);
					try {
						close = await startPeer(label);
						break;
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						if (!message.includes("already online")) throw error;
						taken.add(label);
					}
				}
			}

			if (currentGen !== generation) {
				await close();
				return;
			}

			local = { label, directory, close };
			activeUi = ctx.ui;
		} catch (error) {
			if (currentGen !== generation) return;
			unavailable = error instanceof Error ? error.message : String(error);
			if (ctx.mode === "tui" || ctx.hasUI) {
				ctx.ui.notify(unavailable, "warning");
			}
			return;
		}

		if (ctx.mode === "tui") {
			showSessionLabel(ctx.ui, label, deps, () => currentGen === generation);
		}
	});

	pi.on("session_shutdown", async () => {
		generation++;
		activeUi?.setStatus(extension, undefined);
		activeUi = undefined;
		const current = local;
		local = undefined;
		unavailable = "Pi Caller is closing.";
		await current?.close();
	});

	function currentPeer() {
		if (!local) throw new Error(unavailable);
		return local;
	}

	async function sessions(): Promise<ListedPeer[]> {
		const current = currentPeer();
		return (await listPeers(current.directory)).map((peer) => ({
			...peer,
			self: peer.label === current.label,
		}));
	}

	async function send(to: string, text: string) {
		const current = currentPeer();
		const label = await sendTo(current.directory, to, { from: current.label, text });
		return { label, from: current.label };
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
		async getArgumentCompletions(argumentPrefix) {
			if (!local || /\s/.test(argumentPrefix)) return null;
			const prefix = argumentPrefix.trim().toUpperCase();
			try {
				const peers = await listPeers(local.directory);
				const items = peers
					.filter((peer) => peer.label !== local?.label && peer.label.startsWith(prefix))
					.map((peer) => {
						const cleanName = normalizeSessionName(peer.name);
						return {
							value: `${peer.label} `,
							label: peer.label,
							description: cleanName ? `${cleanName} (${peer.cwd})` : peer.cwd,
						};
					});
				return items.length > 0 ? items : null;
			} catch {
				return null;
			}
		},
		async handler(args, ctx) {
			const match = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
			if (!match) {
				ctx.ui.notify("Usage: /send <label> <message>", "warning");
				return;
			}
			try {
				const { label } = await send(match[1], match[2]);
				ctx.ui.notify(`Accepted by Pi session ${label}.`, "info");
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
		annotations: {
			readOnlyHint: true,
			openWorldHint: false,
		},
		parameters: deps.Type.Object({}),
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
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		parameters: deps.Type.Object({
			to: deps.Type.String({ description: "Pi Caller label of the destination session (e.g. ABC-1) or an unambiguous prefix" }),
			text: deps.Type.String({ description: "The content to deliver to the recipient" }),
		}),
		async execute(_id, { to, text }) {
			const { label, from } = await send(to, text);
			return {
				content: [{ type: "text", text: `Accepted by Pi session ${label}.` }],
				details: { from, to: label },
			};
		},
	});
}
