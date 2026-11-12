import { lookup as dnsLookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import type { Readable } from "node:stream";

/** An error whose message is safe to show to the admin. */
export class DiscoveryError extends Error {}

export interface Resolved {
	address: string;
	family: 4 | 6;
}
export interface Fetched {
	status: number;
	headers: Record<string, string | undefined>;
	body: Readable;
}
export interface FetchDeps {
	lookup?: (host: string) => Promise<Resolved[]>;
	/** Connects to `address` (already checked) while presenting `url`'s host name. */
	get?: (url: URL, address: Resolved) => Promise<Fetched>;
	timeoutMs?: number;
}

const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;
const MAX_TEXT = 20_000;
const TEXT_TYPES = /^(text\/|application\/xhtml\+xml)/;

const nonPublic = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) {
	nonPublic.addSubnet(net, bits, "ipv4");
}
for (const [net, bits] of [["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64], ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {
	nonPublic.addSubnet(net, bits, "ipv6");
}

/** False for loopback, private, link-local, multicast, reserved and documentation addresses (IPv4-mapped IPv6 included). */
export const isPublicAddress = (address: string): boolean => {
	const family = isIP(address);
	return family !== 0 && !nonPublic.check(address, family === 6 ? "ipv6" : "ipv4");
};

const defaultLookup = async (host: string): Promise<Resolved[]> => {
	const answers = await dnsLookup(host, { all: true });
	return answers.map((a) => ({ address: a.address, family: a.family as 4 | 6 }));
};

/** Pins the connection to the checked address: the `lookup` option hands back that address, whatever DNS says now. */
const defaultGet = (url: URL, address: Resolved): Promise<Fetched> =>
	new Promise((resolve, reject) => {
		const req = request(url, { method: "GET", headers: { "user-agent": "benchmark-harness-docs-reader", accept: "text/html,text/plain" }, lookup: (_h, _o, cb) => (cb as (e: null, a: string, f: number) => void)(null, address.address, address.family) }, (res) => {
			const headers: Record<string, string | undefined> = {};
			for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
			resolve({ status: res.statusCode ?? 0, headers, body: res });
		});
		req.on("error", reject);
		req.end();
	});

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
	new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new DiscoveryError("the docs page took too long to answer")), ms);
		promise.then((v) => (clearTimeout(timer), resolve(v)), (e) => (clearTimeout(timer), reject(e)));
	});

async function readCapped(body: Readable): Promise<string> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of body) {
		size += chunk.length;
		if (size > MAX_BYTES) {
			body.destroy();
			throw new DiscoveryError("the docs page is too large (over 1 MB)");
		}
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

const decode = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

const toText = (html: string) =>
	decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, MAX_TEXT);

/**
 * Reads a docs page as plain text for the parameter extractor. HTTPS only, public addresses only (checked again on every
 * redirect, and the connection is pinned to the checked address), size and time limited.
 */
export async function fetchDocsText(rawUrl: string, deps: FetchDeps = {}): Promise<string> {
	const { lookup = defaultLookup, get = defaultGet, timeoutMs = 10_000 } = deps;
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new DiscoveryError("that is not a valid link");
	}
	return withTimeout(
		(async () => {
			for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
				if (url.protocol !== "https:") throw new DiscoveryError("only https links are allowed");
				if (url.username || url.password) throw new DiscoveryError("links with a user name or password are not allowed");
				const host = url.hostname.replace(/^\[|\]$/g, "");
				const answers = isIP(host) ? [{ address: host, family: isIP(host) as 4 | 6 }] : await lookup(host);
				if (!answers.length) throw new DiscoveryError("that host could not be found");
				if (answers.some((a) => !isPublicAddress(a.address))) throw new DiscoveryError("that link points to a private or reserved address");

				const res = await get(url, answers[0]);
				if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
					res.body.destroy();
					url = new URL(res.headers.location, url);
					continue;
				}
				if (res.status < 200 || res.status >= 300) {
					res.body.destroy();
					throw new DiscoveryError(`the docs page answered ${res.status}`);
				}
				if (!TEXT_TYPES.test(res.headers["content-type"] ?? "")) {
					res.body.destroy();
					throw new DiscoveryError("the docs link is not a web page or text");
				}
				return toText(await readCapped(res.body));
			}
			throw new DiscoveryError("the docs link redirects too many times");
		})(),
		timeoutMs,
	);
}
