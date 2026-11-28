import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readdir, readlink, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { request } from "node:http";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
	ephemeralLabel,
	listPeers,
	openPeer,
	privateDirectory,
	sendTo,
	sessionLabel,
	type Message,
	type Peer,
} from "../transport.ts";

const first = { label: "ABC-1", cwd: "/project/a" };
const second = { label: "ABC-2", cwd: "/project/b" };

async function fixture(t: TestContext) {
	const directory = await mkdtemp("/tmp/pi-caller-test-");
	const closers: (() => Promise<void>)[] = [];
	t.after(async () => {
		await Promise.all(closers.map((close) => close()));
		await rm(directory, { recursive: true, force: true });
	});
	return {
		directory,
		async open(peer: Peer | (() => Peer), receive: (message: Message) => void = () => {}) {
			const close = await openPeer(directory, peer, receive);
			closers.push(close);
			return close;
		},
	};
}

async function createDeadSocket(socketPath: string): Promise<void> {
	const tmpPath = `${socketPath}.tmp`;
	const server = createNetServer();
	await new Promise<void>((resolve) => server.listen(tmpPath, resolve));
	await rename(tmpPath, socketPath);
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

function rawHttp(socketPath: string, options: { method: string; path: string; body?: string }) {
	return new Promise<{ statusCode: number | undefined; body: string }>((resolve, reject) => {
		const req = request({
			socketPath,
			path: options.path,
			method: options.method,
			agent: false,
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => {
				resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
			});
		});
		req.on("error", reject);
		req.end(options.body);
	});
}

test("discovers peers, excludes self, and confirms delivery by label or prefix", async (t) => {
	const { directory, open } = await fixture(t);
	const atFirst: Message[] = [];
	const atSecond: Message[] = [];
	await open(first, (message) => atFirst.push(message));
	const closeSecond = await open(second, (message) => atSecond.push(message));

	assert.deepEqual(await listPeers(directory), [first, second]);
	await assert.rejects(sendTo(directory, "ABC", { from: "ZZZ-9", text: "Ambiguous" }), /ambiguous/);

	// Prefix excludes sender automatically when both share the prefix.
	assert.equal(await sendTo(directory, "ABC", { from: first.label, text: "Auto-routed" }), second.label);
	assert.deepEqual(atSecond, [{ from: first.label, text: "Auto-routed" }]);

	const sent = { from: first.label, text: "你好\nsecond line" };
	const reply = { from: second.label, text: "Got it" };
	assert.equal(await sendTo(directory, second.label, sent), second.label);
	assert.equal(await sendTo(directory, "abc-1", reply), first.label);
	assert.deepEqual(atSecond, [{ from: first.label, text: "Auto-routed" }, sent]);
	assert.deepEqual(atFirst, [reply]);

	// Explicit self-send is rejected.
	await assert.rejects(sendTo(directory, first.label, { from: first.label, text: "Self" }), /current session/);

	await closeSecond();
	assert.deepEqual(await listPeers(directory), [first]);
	// Prefix does not fall back to sending to self once the other peer disconnects.
	await assert.rejects(sendTo(directory, "AbC", { from: first.label, text: "Only self left" }), /No online session/);
	await assert.rejects(sendTo(directory, second.label, sent), /No online session/);
});

test("cleans up dead peer registrations, legacy slots, and aged orphan sockets", async (t) => {
	const { directory, open } = await fixture(t);

	// Legacy <label>.<slot>.peer pointing to a missing socket + another dead socket.
	const deadSocketName = "0123456789abcdef01234567.sock";
	const deadSocketPath = join(directory, deadSocketName);
	await createDeadSocket(deadSocketPath);
	await symlink(deadSocketName, join(directory, `${first.label}.0.peer`));

	// Orphan unreferenced dead socket aged past 60s vs fresh unreferenced dead socket.
	const agedOrphan = join(directory, "aaaaaaaaaaaaaaaaaaaaaaaa.sock");
	const freshOrphan = join(directory, "bbbbbbbbbbbbbbbbbbbbbbbb.sock");
	await createDeadSocket(agedOrphan);
	await createDeadSocket(freshOrphan);
	const past = new Date(Date.now() - 120_000);
	await utimes(agedOrphan, past, past);

	assert.deepEqual(await listPeers(directory), []);
	const entriesAfterList = await readdir(directory);
	assert.equal(entriesAfterList.includes(`${first.label}.0.peer`), false);
	assert.equal(entriesAfterList.includes(deadSocketName), false);
	assert.equal(entriesAfterList.includes("aaaaaaaaaaaaaaaaaaaaaaaa.sock"), false);
	assert.equal(entriesAfterList.includes("bbbbbbbbbbbbbbbbbbbbbbbb.sock"), true);

	// Concurrent open race on stale legacy registration allows exactly one live owner.
	await symlink("fedcba9876543210fedcba98.sock", join(directory, `${first.label}.1.peer`));
	const results = await Promise.allSettled([open(first), open(first)]);
	const success = results.filter((r) => r.status === "fulfilled");
	const failure = results.filter((r) => r.status === "rejected");
	assert.equal(success.length, 1);
	assert.equal(failure.length, 1);
	assert.match(String(failure[0].reason), /already online/);
	assert.deepEqual(await listPeers(directory), [first]);

	// Legacy claim was cleaned up and canonical <label>.peer exists.
	const entriesAfterOpen = await readdir(directory);
	assert.equal(entriesAfterOpen.includes(`${first.label}.1.peer`), false);
	assert.equal(entriesAfterOpen.includes(`${first.label}.peer`), true);

	// Idempotent close removes both claim and socket file.
	const close = success[0].value;
	await Promise.all([close(), close()]);
	const entriesAfterClose = await readdir(directory);
	assert.equal(entriesAfterClose.includes(`${first.label}.peer`), false);
	assert.equal(entriesAfterClose.some((name) => name.endsWith(".sock") && name !== "bbbbbbbbbbbbbbbbbbbbbbbb.sock"), false);

	await open(first);
	assert.deepEqual(await listPeers(directory), [first]);
});

test("recovers from a stale registration lock directory", async (t) => {
	const { directory, open } = await fixture(t);
	const lockPath = join(directory, `${first.label}.lock`);
	await mkdir(lockPath, { mode: 0o700 });
	const past = new Date(Date.now() - 20_000);
	await utimes(lockPath, past, past);

	await open(first);
	assert.deepEqual(await listPeers(directory), [first]);
});

test("serves dynamic peer metadata and supports exact-label fast path", async (t) => {
	const { directory, open } = await fixture(t);
	let busy = false;
	let name = "  Refactor\nauth  ";
	await open(() => ({ label: first.label, cwd: first.cwd, name, busy }));
	const received: Message[] = [];
	await open(second, (msg) => received.push(msg));

	assert.deepEqual(await listPeers(directory), [
		{ label: first.label, cwd: first.cwd, name: "Refactor auth", busy: false },
		{ label: second.label, cwd: second.cwd },
	]);

	busy = true;
	name = "";
	assert.deepEqual(await listPeers(directory), [
		{ label: first.label, cwd: first.cwd, busy: true },
		{ label: second.label, cwd: second.cwd },
	]);

	assert.equal(await sendTo(directory, first.label, { from: second.label, text: "Ping" }), first.label);
	assert.equal(await sendTo(directory, second.label, { from: first.label, text: "Pong" }), second.label);
	assert.deepEqual(received, [{ from: first.label, text: "Pong" }]);
});

test("enforces 64 KiB payload limit and HTTP error responses", async (t) => {
	const { directory, open } = await fixture(t);
	await open(first, (message) => {
		if (message.text === "BOOM") throw new Error("handler failed");
	});
	const socketTarget = await readlink(join(directory, `${first.label}.peer`));
	const socketPath = join(directory, socketTarget);

	// Exact 64 KiB payload succeeds.
	const overhead = Buffer.byteLength(JSON.stringify({ from: second.label, text: "" }));
	const maxText = "a".repeat(64 * 1024 - overhead);
	assert.equal(await sendTo(directory, first.label, { from: second.label, text: maxText }), first.label);

	// 64 KiB + 1 byte is rejected client-side and server-side with 413.
	await assert.rejects(
		sendTo(directory, first.label, { from: second.label, text: `${maxText}a` }),
		/exceeds 64 KiB/,
	);
	const tooLarge = await rawHttp(socketPath, {
		method: "POST",
		path: "/",
		body: JSON.stringify({ from: second.label, text: `${maxText}a` }),
	});
	assert.equal(tooLarge.statusCode, 413);

	const badJson = await rawHttp(socketPath, { method: "POST", path: "/", body: "{bad" });
	assert.equal(badJson.statusCode, 400);

	const badSender = await rawHttp(socketPath, {
		method: "POST",
		path: "/",
		body: JSON.stringify({ from: "invalid", text: "hi" }),
	});
	assert.equal(badSender.statusCode, 400);

	const notFound = await rawHttp(socketPath, { method: "GET", path: "/other" });
	assert.equal(notFound.statusCode, 404);

	const handlerErr = await rawHttp(socketPath, {
		method: "POST",
		path: "/",
		body: JSON.stringify({ from: second.label, text: "BOOM" }),
	});
	assert.equal(handlerErr.statusCode, 500);
});

test("assigns distinct labels, skips non-symlink obstacles, and generates ephemeral labels without disk writes", async (t) => {
	const { directory } = await fixture(t);
	const firstId = "session-145";
	const secondId = "session-614";
	const firstOnly = await sessionLabel(firstId, join(directory, "first-only"));
	const secondOnly = await sessionLabel(secondId, join(directory, "second-only"));
	assert.equal(firstOnly, secondOnly);

	// A regular file occupying the first candidate label must not crash sessionLabel.
	const obstacleDir = join(directory, "obstacles");
	await mkdir(obstacleDir, { mode: 0o700 });
	await writeFile(join(obstacleDir, firstOnly), "not-a-symlink");
	const recovered = await sessionLabel(firstId, obstacleDir);
	assert.match(recovered, /^[A-Z]{3}-[0-9]$/);
	assert.notEqual(recovered, firstOnly);

	const registry = join(directory, "labels");
	const [original, sameSession, otherSession] = await Promise.all([
		sessionLabel(firstId, registry),
		sessionLabel(firstId, registry),
		sessionLabel(secondId, registry),
	]);
	assert.match(original, /^[A-Z]{3}-[0-9]$/);
	assert.match(otherSession, /^[A-Z]{3}-[0-9]$/);
	assert.equal(original, sameSession);
	assert.notEqual(original, otherSession);
	assert.equal(await sessionLabel(secondId, registry), otherSession);
	assert.equal(await sessionLabel(firstId, registry), original);

	// Ephemeral labels avoid taken labels and leave nothing on disk.
	const ephemeralFirst = ephemeralLabel(firstId);
	assert.equal(ephemeralFirst, firstOnly);
	const ephemeralSecond = ephemeralLabel(secondId, new Set([ephemeralFirst]));
	assert.notEqual(ephemeralSecond, ephemeralFirst);
	assert.match(ephemeralSecond, /^[A-Z]{3}-[0-9]$/);

	// privateDirectory rejects group/world-accessible directories.
	const insecureDir = join(directory, "insecure");
	await mkdir(insecureDir, { mode: 0o755 });
	await chmod(insecureDir, 0o755);
	await assert.rejects(privateDirectory(insecureDir), /private directory/);
	const stat = await lstat(insecureDir);
	assert.equal(stat.isDirectory(), true);
});
