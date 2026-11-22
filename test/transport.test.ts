import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { listPeers, openPeer, sendTo, sessionLabel, type Message, type Peer } from "../transport.ts";

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
		async open(peer: Peer, receive: (message: Message) => void = () => {}) {
			const close = await openPeer(directory, peer, receive);
			closers.push(close);
			return close;
		},
	};
}

test("discovers peers and confirms delivery by label or prefix in both directions", async (t) => {
	const { directory, open } = await fixture(t);
	const atFirst: Message[] = [];
	const atSecond: Message[] = [];
	await open(first, (message) => atFirst.push(message));
	const closeSecond = await open(second, (message) => atSecond.push(message));
	assert.deepEqual(await listPeers(directory), [first, second]);
	await assert.rejects(sendTo(directory, "ABC", { from: first.label, text: "Ambiguous" }), /ambiguous/);

	const sent = { from: first.label, text: "你好\nsecond line" };
	const reply = { from: second.label, text: "Got it" };
	assert.equal(await sendTo(directory, second.label, sent), second.label);
	assert.equal(await sendTo(directory, "abc-1", reply), first.label);
	assert.deepEqual(atSecond, [sent]);
	assert.deepEqual(atFirst, [reply]);

	await closeSecond();
	assert.deepEqual(await listPeers(directory), [first]);
	assert.equal(await sendTo(directory, "AbC", reply), first.label);
	await assert.rejects(sendTo(directory, second.label, sent), /No online session/);
});

test("a stale registration can be replaced by exactly one live owner", async (t) => {
	const { directory, open } = await fixture(t);
	await symlink("0123456789abcdef01234567.sock", join(directory, first.label + ".0.peer"));
	assert.deepEqual(await listPeers(directory), []);
	const results = await Promise.allSettled([open(first), open(first)]);
	const success = results.filter((result) => result.status === "fulfilled");
	const failure = results.filter((result) => result.status === "rejected");
	assert.equal(success.length, 1);
	assert.equal(failure.length, 1);
	assert.match(String(failure[0].reason), /already online/);
	assert.deepEqual(await listPeers(directory), [first]);
	await success[0].value();
	await open(first);
	assert.deepEqual(await listPeers(directory), [first]);
});

test("assigns distinct labels to colliding sessions and preserves them on resume", async (t) => {
	const { directory } = await fixture(t);
	const firstId = "session-145";
	const secondId = "session-614";
	const firstOnly = await sessionLabel(firstId, join(directory, "first-only"));
	const secondOnly = await sessionLabel(secondId, join(directory, "second-only"));
	assert.equal(firstOnly, secondOnly);

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
});
