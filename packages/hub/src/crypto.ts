/**
 * Hub crypto helpers.
 * - passwords: scrypt (N=2^15, r=8, p=1, 32-byte salt) - "scrypt$N$r$p$salt$hash"
 * - secrets at rest (agent secrets, Prowlarr key): AES-256-GCM with a key file
 * - TOTP (RFC 6238, SHA-1, 6 digits, 30 s) for optional 2FA
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	createHmac,
	randomBytes,
	scrypt as scryptCb,
	timingSafeEqual,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, keylen: number): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scryptCb(password.normalize("NFKC"), salt, keylen, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
			err ? reject(err) : resolve(key),
		);
	});
}

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(32);
	const key = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keylen);
	return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split("$");
	if (parts.length !== 6 || parts[0] !== "scrypt") return false;
	const [, N, r, p, saltB64, hashB64] = parts;
	const expected = Buffer.from(hashB64, "base64");
	const key = await scrypt(password, Buffer.from(saltB64, "base64"), Number(N), Number(r), Number(p), expected.length);
	return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A valid hash of a random password, used to keep login timing constant for unknown users. */
let dummyHash: string | null = null;
export async function dummyVerify(password: string) {
	dummyHash ??= await hashPassword(randomBytes(16).toString("hex"));
	await verifyPassword(password, dummyHash);
}

export function passwordProblems(pw: string, username?: string): string | null {
	if (typeof pw !== "string" || pw.length < 10) return "Password must be at least 10 characters.";
	if (pw.length > 256) return "Password is too long.";
	if (username && pw.toLowerCase().includes(username.toLowerCase())) return "Password must not contain the username.";
	if (/^(.)\1+$/.test(pw)) return "Password is too simple.";
	return null;
}

export function randomToken(bytes = 32): string {
	return randomBytes(bytes).toString("base64url");
}

export function sha256(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

// ------------------------------------------------------------ encryption at rest

export class SecretBox {
	private key: Buffer;
	constructor(keyFile: string) {
		if (!existsSync(keyFile)) {
			writeFileSync(keyFile, randomBytes(32).toString("base64"), { mode: 0o600 });
		}
		this.key = Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
		if (this.key.length !== 32) throw new Error(`${keyFile} must contain 32 base64-encoded bytes`);
	}
	encrypt(plain: string): string {
		const iv = randomBytes(12);
		const c = createCipheriv("aes-256-gcm", this.key, iv);
		const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
		return `v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
	}
	decrypt(box: string): string {
		const [v, iv, tag, data] = box.split(":");
		if (v !== "v1") throw new Error("Unknown secret format");
		const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
		d.setAuthTag(Buffer.from(tag, "base64"));
		return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
	}
}

// ------------------------------------------------------------ TOTP

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of buf) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(s: string): Buffer {
	const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const ch of clean) {
		value = (value << 5) | B32.indexOf(ch);
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return Buffer.from(out);
}

export function newTotpSecret(): string {
	return base32Encode(randomBytes(20));
}

export function totpCode(secret: string, counter: number): string {
	const buf = Buffer.alloc(8);
	buf.writeBigUInt64BE(BigInt(counter));
	const h = createHmac("sha1", base32Decode(secret)).update(buf).digest();
	const off = h[h.length - 1] & 0xf;
	const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
	return String(bin % 1_000_000).padStart(6, "0");
}

/** Returns the matched time-step counter (to prevent reuse) or null. */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
	if (!/^\d{6}$/.test(code)) return null;
	const counter = Math.floor(now / 30_000);
	for (const c of [counter, counter - 1, counter + 1]) {
		const expected = Buffer.from(totpCode(secret, c));
		if (timingSafeEqual(expected, Buffer.from(code))) return c;
	}
	return null;
}

export function totpUri(secret: string, account: string, issuer = "cross-seed-ui"): string {
	return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
