import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, readdir, readlink, rmdir, symlink, unlink } from "node:fs/promises";
import { createServer, request, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export type Peer = { label: string; cwd: string; name?: string; busy?: boolean };
export type Message = { from: string; text: string };

type OnlinePeer = Peer & { socket: string; canonical: boolean };

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const letterCount = alphabet.length;
const labelCount = letterCount ** 3 * 10;
const labelPattern = /^[A-Z]{3}-[0-9]$/;
const claimPattern = /^([A-Z]{3}-[0-9])(?:\.\d+)?\.peer$/;
const socketPattern = /^[0-9a-f]{24}\.sock$/;
const maxBodyBytes = 64 * 1024;
const timeoutMs = 1500;
const staleLockMs = 10_000;
const lockTimeoutMs = 5_000;
const lockRetryMs = 25;
const orphanSocketGraceMs = 60_000;

class PayloadTooLargeError extends Error {
	constructor() {
		super("Message payload exceeds 64 KiB.");
	}
}

function hasCode(error: unknown, ...codes: string[]): boolean {
	return codes.includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function unlinkIgnoreMissing(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
}

function userId(): number {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("Pi Caller requires Unix domain sockets on a POSIX system.");
	return uid;
}

function isOwnedPrivateDirectory(stat: Awaited<ReturnType<typeof lstat>>, uid: number): boolean {
	return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0;
}

export async function privateDirectory(directory: string, uid = userId()): Promise<string> {
	await mkdir(directory, { mode: 0o700, recursive: true });
	const stat = await lstat(directory);
	if (!isOwnedPrivateDirectory(stat, uid)) {
		throw new Error(`${directory} must be a private directory owned by the current user.`);
	}
	return directory;
}

export async function runtimeDirectory(): Promise<string> {
	const uid = userId();
	if (process.platform === "linux") {
		const userRun = `/run/user/${uid}`;
		try {
			const stat = await lstat(userRun);
			if (isOwnedPrivateDirectory(stat, uid)) {
				return await privateDirectory(join(userRun, "pi-caller"), uid);
			}
		} catch (error) {
			if (!hasCode(error, "ENOENT", "ENOTDIR", "EACCES")) throw error;
		}
	}
	return privateDirectory(`/tmp/pi-caller-${uid}`, uid);
}

function labelAt(index: number): string {
	const letters = Math.floor(index / 10);
	const first = alphabet[Math.floor(letters / letterCount ** 2)];
	const second = alphabet[Math.floor(letters / letterCount) % letterCount];
	const third = alphabet[letters % letterCount];
	return `${first}${second}${third}-${index % 10}`;
}

export async function sessionLabel(id: string, directory = join(homedir(), ".pi", "pi-caller-labels")): Promise<string> {
	await privateDirectory(directory, userId());
	const hash = createHash("sha256").update(id).digest();
	const owner = hash.toString("hex");
	const start = hash.readUInt32BE(0) % labelCount;
	for (let offset = 0; offset < labelCount; offset++) {
		const label = labelAt((start + offset) % labelCount);
		const reservation = join(directory, label);
		try {
			// Keep reservations on disk so colliding sessions retain their labels in any resume order.
			await symlink(owner, reservation);
			return label;
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
		}
		try {
			if (await readlink(reservation) === owner) return label;
		} catch (error) {
			if (!hasCode(error, "EINVAL", "ENOENT")) throw error;
		}
	}
	throw new Error("All Pi Caller labels are reserved.");
}

export function ephemeralLabel(id: string, taken: ReadonlySet<string> = new Set()): string {
	const hash = createHash("sha256").update(id).digest();
	const start = hash.readUInt32BE(0) % labelCount;
	for (let offset = 0; offset < labelCount; offset++) {
		const label = labelAt((start + offset) % labelCount);
		if (!taken.has(label)) return label;
	}
	throw new Error("All Pi Caller labels are reserved.");
}

async function readBody(message: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of message) {
		bytes += chunk.length;
		if (bytes > maxBodyBytes) throw new PayloadTooLargeError();
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function exchange(socket: string, body?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const connection = request({
			socketPath: socket,
			path: "/",
			method: body === undefined ? "GET" : "POST",
			agent: false,
			signal: AbortSignal.timeout(timeoutMs),
		}, async (response) => {
			try {
				const text = await readBody(response);
				if (response.statusCode !== 200 && response.statusCode !== 204) {
					throw new Error(text || `Request failed (HTTP ${response.statusCode}).`);
				}
				resolve(text);
			} catch (error) {
				reject(error);
			}
		});
		connection.on("error", reject);
		connection.end(body);
	});
}

async function removeStaleLock(lockPath: string): Promise<void> {
	try {
		const stat = await lstat(lockPath);
		if (Date.now() - stat.mtimeMs <= staleLockMs) return;
		if (stat.isDirectory()) {
			await rmdir(lockPath);
		} else {
			await unlink(lockPath);
		}
	} catch (error) {
		if (!hasCode(error, "ENOENT", "ENOTEMPTY")) throw error;
	}
}

async function withLabelLock<T>(directory: string, label: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = join(directory, `${label}.lock`);
	const deadline = Date.now() + lockTimeoutMs;
	for (;;) {
		try {
			await mkdir(lockPath, { mode: 0o700 });
			break;
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
		}
		await removeStaleLock(lockPath);
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for registration lock for ${label}.`);
		}
		await sleep(lockRetryMs);
	}
	try {
		return await fn();
	} finally {
		await rmdir(lockPath).catch(() => {});
	}
}

async function tryWithLabelLock<T>(directory: string, label: string, fn: () => Promise<T>): Promise<T | undefined> {
	const lockPath = join(directory, `${label}.lock`);
	try {
		await mkdir(lockPath, { mode: 0o700 });
	} catch (error) {
		if (hasCode(error, "EEXIST")) return undefined;
		throw error;
	}
	try {
		return await fn();
	} finally {
		await rmdir(lockPath).catch(() => {});
	}
}

async function readClaimTarget(claimPath: string): Promise<string | undefined> {
	try {
		const target = await readlink(claimPath);
		if (!socketPattern.test(target)) throw new Error(`Invalid peer registration: ${claimPath}`);
		return target;
	} catch (error) {
		if (!hasCode(error, "ENOENT", "EINVAL")) throw error;
	}
	return undefined;
}

async function register(directory: string, label: string, socketName: string): Promise<string> {
	return withLabelLock(directory, label, async () => {
		const entries = await readdir(directory);
		for (const name of entries) {
			const match = claimPattern.exec(name);
			if (!match || match[1] !== label) continue;
			const claimPath = join(directory, name);
			let target: string | undefined;
			try {
				target = await readClaimTarget(claimPath);
			} catch {
				await unlinkIgnoreMissing(claimPath);
				continue;
			}
			if (!target) {
				await unlinkIgnoreMissing(claimPath);
				continue;
			}
			const existing = join(directory, target);
			try {
				await exchange(existing);
			} catch (error) {
				if (hasCode(error, "ECONNREFUSED", "ENOENT")) {
					await unlinkIgnoreMissing(existing);
					await unlinkIgnoreMissing(claimPath);
					continue;
				}
				if (hasCode(error, "ABORT_ERR")) {
					throw new Error(`Session ${label} is unresponsive in another Pi process.`);
				}
				throw error;
			}
			throw new Error(`Session ${label} is already online in another Pi process.`);
		}

		const claim = join(directory, `${label}.peer`);
		await symlink(socketName, claim);
		return claim;
	});
}

function normalizePeer(label: string, raw: Peer): Peer {
	const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim() : "";
	return {
		label,
		cwd: raw.cwd,
		...(name ? { name } : {}),
		...(typeof raw.busy === "boolean" ? { busy: raw.busy } : {}),
	};
}

export async function openPeer(directory: string, peer: Peer | (() => Peer), receive: (message: Message) => void) {
	const initial = typeof peer === "function" ? peer() : peer;
	if (!labelPattern.test(initial.label)) throw new Error("Invalid session label.");
	const socketName = `${randomBytes(12).toString("hex")}.sock`;
	const socketPath = join(directory, socketName);
	let closing = false;
	const server = createServer(async (incoming, response) => {
		if (incoming.url !== "/" || (incoming.method !== "GET" && incoming.method !== "POST")) {
			response.writeHead(404).end();
			return;
		}
		if (incoming.method === "GET") {
			const snapshot = typeof peer === "function" ? peer() : peer;
			response.end(JSON.stringify(normalizePeer(initial.label, snapshot)));
			return;
		}
		let rawBody: string;
		try {
			rawBody = await readBody(incoming);
		} catch (error) {
			if (error instanceof PayloadTooLargeError) {
				response.writeHead(413).end(error.message);
				return;
			}
			response.writeHead(400).end("Invalid message payload.");
			return;
		}
		let message: Partial<Message> | null;
		try {
			message = JSON.parse(rawBody);
		} catch {
			response.writeHead(400).end("Invalid message payload.");
			return;
		}
		if (!message || typeof message.from !== "string" || !labelPattern.test(message.from)
			|| typeof message.text !== "string" || !message.text.trim()) {
			response.writeHead(400).end("Invalid sender or message text.");
			return;
		}
		if (closing) {
			response.writeHead(503).end(`Session ${initial.label} is closing.`);
			return;
		}
		try {
			receive({ from: message.from, text: message.text });
			response.writeHead(204).end();
		} catch {
			response.writeHead(500).end(`Session ${initial.label} could not accept the message.`);
		}
	});
	server.setTimeout(timeoutMs, (socket) => socket.destroy());
	await once(server.listen(socketPath), "listening");
	server.on("error", () => {});

	async function closeServer() {
		server.closeAllConnections();
		await new Promise<void>((resolve) => {
			if (!server.listening) {
				resolve();
				return;
			}
			server.close(() => resolve());
		});
		await unlinkIgnoreMissing(socketPath);
	}

	let claim: string;
	try {
		claim = await register(directory, initial.label, socketName);
	} catch (error) {
		await closeServer();
		throw error;
	}

	let closedPromise: Promise<void> | undefined;
	return () => {
		if (!closedPromise) {
			closing = true;
			closedPromise = (async () => {
				try {
					await unlinkIgnoreMissing(claim);
				} finally {
					await closeServer();
				}
			})();
		}
		return closedPromise;
	};
}

async function probeClaim(directory: string, label: string, name: string): Promise<OnlinePeer | undefined> {
	const claimPath = join(directory, name);
	let target: string | undefined;
	try {
		target = await readClaimTarget(claimPath);
	} catch {
		return undefined;
	}
	if (!target) return undefined;

	const socket = join(directory, target);
	try {
		const raw = JSON.parse(await exchange(socket)) as Partial<Peer> | null;
		if (raw?.label === label && typeof raw.cwd === "string") {
			return {
				...normalizePeer(label, raw as Peer),
				socket,
				canonical: name === `${label}.peer`,
			};
		}
	} catch (error) {
		if (hasCode(error, "ECONNREFUSED", "ENOENT")) {
			await tryWithLabelLock(directory, label, async () => {
				const currentTarget = await readlink(claimPath).catch(() => undefined);
				if (currentTarget === target) {
					await unlinkIgnoreMissing(socket);
					await unlinkIgnoreMissing(claimPath);
				}
			}).catch(() => {});
		}
	}
	return undefined;
}

async function sweepOrphanSockets(directory: string, entries: string[], referencedSockets: Set<string>): Promise<void> {
	const now = Date.now();
	await Promise.all(entries.map(async (name) => {
		if (!socketPattern.test(name) || referencedSockets.has(name)) return;
		const socketPath = join(directory, name);
		try {
			const stat = await lstat(socketPath);
			if (!stat.isSocket() || now - stat.mtimeMs <= orphanSocketGraceMs) return;
			try {
				await exchange(socketPath);
			} catch (error) {
				if (hasCode(error, "ECONNREFUSED", "ENOENT")) {
					await unlinkIgnoreMissing(socketPath);
				}
			}
		} catch {
			// Ignore transient filesystem errors during opportunistic orphan sweep.
		}
	}));
}

async function onlinePeers(directory: string): Promise<OnlinePeer[]> {
	const entries = await readdir(directory);
	const claims: { label: string; name: string }[] = [];
	const referencedSockets = new Set<string>();

	await Promise.all(entries.map(async (name) => {
		const label = claimPattern.exec(name)?.[1];
		if (!label) return;
		claims.push({ label, name });
		try {
			const target = await readClaimTarget(join(directory, name));
			if (target) referencedSockets.add(target);
		} catch {
			// Invalid registration target; probeClaim ignores it.
		}
	}));

	const [probed] = await Promise.all([
		Promise.all(claims.map(({ label, name }) => probeClaim(directory, label, name))),
		sweepOrphanSockets(directory, entries, referencedSockets),
	]);

	const byLabel = new Map<string, OnlinePeer>();
	for (const peer of probed) {
		if (!peer) continue;
		const existing = byLabel.get(peer.label);
		if (!existing || (peer.canonical && !existing.canonical)) {
			byLabel.set(peer.label, peer);
		}
	}
	return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export async function listPeers(directory: string): Promise<Peer[]> {
	return (await onlinePeers(directory)).map(({ label, cwd, name, busy }) => ({
		label,
		cwd,
		...(name !== undefined ? { name } : {}),
		...(busy !== undefined ? { busy } : {}),
	}));
}

async function findPeerByLabel(directory: string, label: string): Promise<OnlinePeer | undefined> {
	const canonicalName = `${label}.peer`;
	const direct = await probeClaim(directory, label, canonicalName);
	if (direct) return direct;

	const entries = await readdir(directory);
	for (const name of entries) {
		if (name === canonicalName) continue;
		const match = claimPattern.exec(name);
		if (!match || match[1] !== label) continue;
		const legacy = await probeClaim(directory, label, name);
		if (legacy) return legacy;
	}
	return undefined;
}

export async function sendTo(directory: string, target: string, message: Message): Promise<string> {
	const prefix = target.trim().toUpperCase();
	const sender = message.from.trim().toUpperCase();
	if (!prefix || !message.text.trim()) throw new Error("A target label and message are required.");
	if (prefix === sender) throw new Error(`Cannot send a message to the current session (${sender}).`);

	const body = JSON.stringify(message);
	if (Buffer.byteLength(body) > maxBodyBytes) throw new Error("Message payload exceeds 64 KiB.");

	let peer: OnlinePeer | undefined;
	if (labelPattern.test(prefix)) {
		peer = await findPeerByLabel(directory, prefix);
		if (!peer) throw new Error(`No online session matches ${prefix}.`);
	} else {
		const matches = (await onlinePeers(directory)).filter(({ label }) => label !== sender && label.startsWith(prefix));
		peer = matches.length === 1 ? matches[0] : undefined;
		if (!peer) {
			if (matches.length === 0) throw new Error(`No online session matches ${prefix}.`);
			throw new Error(`Label ${prefix} is ambiguous. Use a longer prefix: ${matches.map(({ label }) => label).join(", ")}.`);
		}
	}

	try {
		await exchange(peer.socket, body);
	} catch (error) {
		if (hasCode(error, "ECONNREFUSED", "ENOENT")) throw new Error(`Session ${peer.label} is no longer online.`);
		if (hasCode(error, "ABORT_ERR", "ECONNRESET", "EPIPE")) {
			throw new Error(`Session ${peer.label} did not acknowledge the message.`);
		}
		throw error;
	}
	return peer.label;
}
