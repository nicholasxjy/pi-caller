import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, readdir, readlink, symlink, unlink } from "node:fs/promises";
import { createServer, request, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

export type Peer = { label: string; cwd: string };
export type Message = { from: string; text: string };

type OnlinePeer = Peer & { socket: string };

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const letterCount = alphabet.length;
const labelCount = letterCount ** 3 * 10;
const labelPattern = /^[A-Z]{3}-[0-9]$/;
const claimPattern = /^([A-Z]{3}-[0-9])\.\d+\.peer$/;
const socketPattern = /^[0-9a-f]{24}\.sock$/;
const maxBodyBytes = 64 * 1024;
const timeoutMs = 1500;

function hasCode(error: unknown, ...codes: string[]): boolean {
	return codes.includes((error as NodeJS.ErrnoException | undefined)?.code ?? "");
}

function userId(): number {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("Pi Caller requires Unix domain sockets on a POSIX system.");
	return uid;
}

async function privateDirectory(directory: string, uid: number): Promise<string> {
	await mkdir(directory, { mode: 0o700, recursive: true });
	const stat = await lstat(directory);
	if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
		throw new Error(`${directory} must be a private directory owned by the current user.`);
	}
	return directory;
}

export function runtimeDirectory(): Promise<string> {
	const uid = userId();
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
		if (await readlink(reservation) === owner) return label;
	}
	throw new Error("All Pi Caller labels are reserved.");
}

async function readBody(message: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of message) {
		bytes += chunk.length;
		if (bytes > maxBodyBytes) throw new Error("Message payload exceeds 64 KiB.");
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

async function claimedSocket(directory: string, claim: string): Promise<string | undefined> {
	try {
		const target = await readlink(claim);
		if (!socketPattern.test(target)) throw new Error(`Invalid peer registration: ${claim}`);
		return join(directory, target);
	} catch (error) {
		if (!hasCode(error, "ENOENT")) throw error;
	}
}

async function register(directory: string, label: string, socketName: string): Promise<string> {
	for (let slot = 0; ; ) {
		const claim = join(directory, `${label}.${slot}.peer`);
		try {
			await symlink(socketName, claim);
			return claim;
		} catch (error) {
			if (!hasCode(error, "EEXIST")) throw error;
		}

		const existing = await claimedSocket(directory, claim);
		if (!existing) continue;
		try {
			await exchange(existing);
		} catch (error) {
			if (!hasCode(error, "ECONNREFUSED", "ENOENT")) throw error;
			// A crashed owner's claim stays in place so concurrent restarts agree on the next slot.
			if (await claimedSocket(directory, claim) === existing) slot++;
			continue;
		}
		throw new Error(`Session ${label} is already online in another Pi process.`);
	}
}

export async function openPeer(directory: string, peer: Peer, receive: (message: Message) => void) {
	if (!labelPattern.test(peer.label)) throw new Error("Invalid session label.");
	const socketName = `${randomBytes(12).toString("hex")}.sock`;
	let closing = false;
	const server = createServer(async (incoming, response) => {
		if (incoming.url !== "/" || (incoming.method !== "GET" && incoming.method !== "POST")) {
			response.writeHead(404).end();
			return;
		}
		if (incoming.method === "GET") {
			response.end(JSON.stringify(peer));
			return;
		}
		let message: Partial<Message> | null;
		try {
			message = JSON.parse(await readBody(incoming));
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
			response.writeHead(503).end(`Session ${peer.label} is closing.`);
			return;
		}
		try {
			receive({ from: message.from, text: message.text });
			response.writeHead(204).end();
		} catch {
			response.writeHead(500).end(`Session ${peer.label} could not accept the message.`);
		}
	});
	server.setTimeout(timeoutMs, (socket) => socket.destroy());
	await once(server.listen(join(directory, socketName)), "listening");

	function closeServer() {
		server.close();
		server.closeAllConnections();
	}

	let claim: string;
	try {
		claim = await register(directory, peer.label, socketName);
	} catch (error) {
		closeServer();
		throw error;
	}
	return async () => {
		if (closing) return;
		closing = true;
		try {
			await unlink(claim);
		} finally {
			closeServer();
		}
	};
}

async function onlinePeers(directory: string): Promise<OnlinePeer[]> {
	const claims = await readdir(directory);
	const peers = await Promise.all(claims.map(async (name) => {
		const label = claimPattern.exec(name)?.[1];
		if (!label) return;
		try {
			const socket = await claimedSocket(directory, join(directory, name));
			if (!socket) return;
			const peer = JSON.parse(await exchange(socket));
			if (peer?.label === label && typeof peer.cwd === "string") return { label, cwd: peer.cwd, socket };
		} catch {
			// A discovered endpoint can disappear before it responds.
		}
	}));
	return peers.filter((peer) => peer !== undefined).sort((a, b) => a.label.localeCompare(b.label));
}

export async function listPeers(directory: string): Promise<Peer[]> {
	return (await onlinePeers(directory)).map(({ label, cwd }) => ({ label, cwd }));
}

export async function sendTo(directory: string, target: string, message: Message): Promise<string> {
	const prefix = target.trim().toUpperCase();
	if (!prefix || !message.text.trim()) throw new Error("A target label and message are required.");
	const body = JSON.stringify(message);
	if (Buffer.byteLength(body) > maxBodyBytes) throw new Error("Message payload exceeds 64 KiB.");
	const matches = (await onlinePeers(directory)).filter(({ label }) => label.startsWith(prefix));
	const peer = matches.find(({ label }) => label === prefix) ?? (matches.length === 1 ? matches[0] : undefined);
	if (!peer) {
		if (matches.length === 0) throw new Error(`No online session matches ${prefix}.`);
		throw new Error(`Label ${prefix} is ambiguous. Use a longer prefix: ${matches.map(({ label }) => label).join(", ")}.`);
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
