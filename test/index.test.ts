import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createPiCaller, describeSessions, extension, type PiCallerDeps } from "../extension.ts";
import { openPeer } from "../transport.ts";

class FakeCustomEditor {
	borderColor = (text: string) => text;
	private widthOverride = 80;
	render(width: number): string[] {
		const effective = Math.min(width, this.widthOverride);
		return ["─".repeat(Math.max(0, effective)), "input", "─".repeat(Math.max(0, effective))];
	}
}

const fakeType = {
	Object: (props: Record<string, unknown>) => ({ type: "object", properties: props }),
	String: (opts?: Record<string, unknown>) => ({ type: "string", ...(opts ?? {}) }),
} as unknown as PiCallerDeps["Type"];

function createHarness(t: TestContext, options: {
	mode?: "tui" | "rpc" | "print" | "json";
	hasUI?: boolean;
	sessionId?: string;
	sessionFile?: string | undefined;
	cwd?: string;
	sessionName?: string;
	idle?: boolean;
	runtimeDir: string;
	labelDir: string;
	runtimeDirectoryOverride?: () => Promise<string>;
}) {
	const handlers = new Map<string, ((event: any, ctx: any) => Promise<void> | void)[]>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const sentMessages: any[] = [];
	const notifications: { message: string; type?: string }[] = [];
	const statuses: Array<{ key: string; text: string | undefined }> = [];
	let editorFactory: ((tui: any, theme: any, keybindings: any) => any) | undefined;
	let sessionName = options.sessionName;
	let idle = options.idle ?? true;

	const ui = {
		notify(message: string, type?: "info" | "warning" | "error") {
			notifications.push({ message, type });
		},
		setStatus(key: string, text: string | undefined) {
			statuses.push({ key, text });
		},
		getEditorComponent() {
			return editorFactory as any;
		},
		setEditorComponent(factory: any) {
			editorFactory = factory;
		},
	};

	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? (options.mode ?? "tui") === "tui",
		cwd: options.cwd ?? "/workspace/project",
		ui,
		sessionManager: {
			getSessionId: () => options.sessionId ?? "sess-1",
			getSessionFile: () => ("sessionFile" in options ? options.sessionFile : "/tmp/sess-1.jsonl"),
		},
		isIdle: () => idle,
	};

	const pi = {
		on(event: string, handler: any) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand(name: string, def: any) {
			commands.set(name, def);
		},
		registerTool(def: any) {
			tools.set(def.name, def);
		},
		sendMessage(message: any, opts: any) {
			sentMessages.push({ message, opts });
		},
		getSessionName: () => sessionName,
	};

	createPiCaller(pi as any, {
		CustomEditor: FakeCustomEditor as any,
		stripTerminalSequences: (s) => s.replace(/\x1b\[[0-9;]*m/g, ""),
		truncateToWidth: (s, width, ellipsis = "") => {
			if (s.length <= width) return s;
			return s.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis;
		},
		Type: fakeType,
		runtimeDirectory: options.runtimeDirectoryOverride ?? (async () => options.runtimeDir),
		labelDirectory: options.labelDir,
	});

	const harness = {
		ctx,
		commands,
		tools,
		sentMessages,
		notifications,
		statuses,
		getEditorFactory: () => editorFactory,
		setSessionName: (next: string | undefined) => {
			sessionName = next;
		},
		setIdle: (next: boolean) => {
			idle = next;
		},
		async emit(event: string, payload: any = {}) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx);
			}
		},
	};
	t.after(async () => {
		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	});
	return harness;
}

async function setupDirs(t: TestContext) {
	const root = await mkdtemp("/tmp/pi-caller-ext-");
	const runtimeDir = join(root, "runtime");
	const labelDir = join(root, "labels");
	const { mkdir } = await import("node:fs/promises");
	await mkdir(runtimeDir, { mode: 0o700 });
	await mkdir(labelDir, { mode: 0o700 });
	t.after(async () => {
		await rm(root, { recursive: true, force: true });
	});
	return { runtimeDir, labelDir };
}

test("skips registration in print and json modes, enables rpc without editor patch, and keeps --no-session ephemeral", async (t) => {
	for (const mode of ["print", "json"] as const) {
		const { runtimeDir, labelDir } = await setupDirs(t);
		const h = createHarness(t, { mode, hasUI: false, runtimeDir, labelDir });
		await h.emit("session_start", { type: "session_start", reason: "startup" });
		assert.deepEqual(await readdir(runtimeDir), []);
		assert.deepEqual(await readdir(labelDir), []);
		assert.equal(h.getEditorFactory(), undefined);
		await assert.rejects(h.tools.get("pi_caller_list").execute("1", {}, undefined, undefined, h.ctx), /disabled/);
		await h.emit("session_shutdown");
	}

	// RPC mode registers peer without patching TUI editor.
	{
		const { runtimeDir, labelDir } = await setupDirs(t);
		const h = createHarness(t, { mode: "rpc", hasUI: true, runtimeDir, labelDir, sessionId: "rpc-sess" });
		await h.emit("session_start", { type: "session_start", reason: "startup" });
		assert.equal(h.getEditorFactory(), undefined);
		assert.equal((await readdir(runtimeDir)).some((f) => f.endsWith(".peer")), true);
		assert.equal((await readdir(labelDir)).length, 1);
		await h.emit("session_shutdown");
	}

	// --no-session (getSessionFile() === undefined) does not touch labelDirectory.
	{
		const { runtimeDir, labelDir } = await setupDirs(t);
		const h = createHarness(t, {
			mode: "tui",
			runtimeDir,
			labelDir,
			sessionId: "ephemeral-sess",
			sessionFile: undefined,
		});
		await h.emit("session_start", { type: "session_start", reason: "startup" });
		assert.equal((await readdir(runtimeDir)).some((f) => f.endsWith(".peer")), true);
		assert.deepEqual(await readdir(labelDir), []);
		await h.emit("session_shutdown");
	}
});

test("cleans up if session_shutdown arrives while session_start is still initializing", async (t) => {
	const { runtimeDir, labelDir } = await setupDirs(t);
	let releaseRuntimeDir!: () => void;
	const dirGate = new Promise<string>((resolve) => {
		releaseRuntimeDir = () => resolve(runtimeDir);
	});

	const h = createHarness(t, {
		mode: "tui",
		runtimeDir,
		labelDir,
		runtimeDirectoryOverride: () => dirGate,
	});

	const startPromise = h.emit("session_start", { type: "session_start", reason: "startup" });
	await h.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
	releaseRuntimeDir();
	await startPromise;

	assert.deepEqual(await readdir(runtimeDir), []);
	assert.equal(h.getEditorFactory(), undefined);
});

test("supports /sessions formatting, /send completions, tool metadata, and incoming message delivery", async (t) => {
	const { runtimeDir, labelDir } = await setupDirs(t);
	const h = createHarness(t, {
		mode: "tui",
		runtimeDir,
		labelDir,
		sessionId: "main-session",
		sessionName: "Fix   auth\nflow",
		idle: false,
	});
	await h.emit("session_start", { type: "session_start", reason: "startup" });

	const peerClose = await openPeer(
		runtimeDir,
		{ label: "ZZZ-9", cwd: "/other/repo", name: "Review PR", busy: true },
		() => {},
	);
	t.after(peerClose);

	const listTool = h.tools.get("pi_caller_list");
	const sendTool = h.tools.get("pi_caller_send");
	assert.deepEqual(listTool.annotations, { readOnlyHint: true, openWorldHint: false });
	assert.deepEqual(sendTool.annotations, {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	});

	const listRes = await listTool.execute("t1", {}, undefined, undefined, h.ctx);
	const selfPeer = listRes.details.peers.find((p: any) => p.self);
	assert.ok(selfPeer);
	assert.equal(selfPeer.busy, true);
	assert.equal(selfPeer.name, "Fix auth flow");
	assert.match(listRes.content[0].text, /\(you\) \[busy\]  \/workspace\/project  — Fix auth flow/);
	assert.match(listRes.content[0].text, /ZZZ-9 \[busy\]  \/other\/repo  — Review PR/);

	// Empty session list message.
	assert.equal(describeSessions([]), "No online Pi Caller sessions.");

	// /send completions exclude self and stop after whitespace.
	const sendCmd = h.commands.get("send");
	const allCompletions = await sendCmd.getArgumentCompletions("");
	assert.deepEqual(allCompletions, [
		{ value: "ZZZ-9 ", label: "ZZZ-9", description: "Review PR (/other/repo)" },
	]);
	assert.equal(await sendCmd.getArgumentCompletions(selfPeer.label), null);
	assert.equal(await sendCmd.getArgumentCompletions("ZZZ-9 hello"), null);

	// /send command + pi_caller_send details.
	await sendCmd.handler("badargs", h.ctx);
	assert.equal(h.notifications.at(-1)?.type, "warning");

	const sendRes = await sendTool.execute("t2", { to: "ZZZ", text: "Hello" }, undefined, undefined, h.ctx);
	assert.deepEqual(sendRes.details, { from: selfPeer.label, to: "ZZZ-9" });
	assert.equal(sendRes.content[0].text, "Accepted by Pi session ZZZ-9.");

	// /sessions command notifies formatted list.
	await h.commands.get("sessions").handler("", h.ctx);
	assert.equal(h.notifications.at(-1)?.type, "info");
	assert.match(h.notifications.at(-1)!.message, /ZZZ-9/);

	await h.emit("session_shutdown");
});

test("renders badge in top border on wide screens and falls back to status bar on narrow screens", async (t) => {
	const { runtimeDir, labelDir } = await setupDirs(t);
	const h = createHarness(t, { mode: "tui", runtimeDir, labelDir, sessionId: "ui-session" });
	await h.emit("session_start", { type: "session_start", reason: "startup" });

	const factory = h.getEditorFactory();
	assert.ok(factory);
	const editor = factory!(
		{} as any,
		{ borderColor: (s: string) => s } as any,
		{} as any,
	);

	// Wide terminal: renders badge in top border, no status fallback.
	const wideLines = editor.render(60);
	assert.match(wideLines[0], /\x1b\[7m [A-Z]{3}-[0-9] \x1b\[27m──$/);
	await new Promise<void>((r) => queueMicrotask(r));
	assert.equal(h.statuses.at(-1)?.text, undefined);

	// Narrow terminal: falls back to bottom status bar.
	const narrowLines = editor.render(8);
	assert.equal(/\x1b\[7m/.test(narrowLines[0]), false);
	await new Promise<void>((r) => queueMicrotask(r));
	assert.match(h.statuses.at(-1)?.text ?? "", /^[A-Z]{3}-[0-9]$/);
	assert.equal(h.statuses.at(-1)?.key, extension);

	// Recovering width clears status fallback.
	editor.render(60);
	await new Promise<void>((r) => queueMicrotask(r));
	assert.equal(h.statuses.at(-1)?.text, undefined);

	// Shutdown clears status.
	editor.render(8);
	await new Promise<void>((r) => queueMicrotask(r));
	await h.emit("session_shutdown");
	assert.equal(h.statuses.at(-1)?.text, undefined);
});
