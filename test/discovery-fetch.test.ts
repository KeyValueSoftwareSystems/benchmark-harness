import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { DiscoveryError, fetchDocsText, isPublicAddress, type Fetched } from "../src/api/discovery/fetch.ts";

const PUBLIC = { address: "93.184.216.34", family: 4 as const };
const page = (body: string, over: Partial<Fetched> = {}): Fetched => ({
	status: 200,
	headers: { "content-type": "text/html; charset=utf-8" },
	body: Readable.from([Buffer.from(body)]),
	...over,
});
const redirect = (location: string): Fetched => ({ status: 302, headers: { location }, body: Readable.from([]) });

const refused = (promise: Promise<unknown>) => assert.rejects(promise, DiscoveryError);

test("plain http links are refused before any lookup", async () => {
	let looked = false;
	await refused(fetchDocsText("http://docs.example/model", { lookup: async () => ((looked = true), [PUBLIC]), get: async () => page("x") }));
	assert.equal(looked, false);
});

test("links with credentials and invalid links are refused", async () => {
	await refused(fetchDocsText("https://user:pw@docs.example/", { lookup: async () => [PUBLIC], get: async () => page("x") }));
	await refused(fetchDocsText("not a url", { lookup: async () => [PUBLIC], get: async () => page("x") }));
});

for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.1", "172.16.0.9", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
	test(`a host resolving to ${address} is refused`, async () => {
		const family = address.includes(":") ? (6 as const) : (4 as const);
		let fetched = false;
		await refused(fetchDocsText("https://internal.test/", { lookup: async () => [{ address, family }], get: async () => ((fetched = true), page("x")) }));
		assert.equal(fetched, false);
	});
}

test("a host with one public and one private answer is refused", async () => {
	await refused(fetchDocsText("https://mixed.test/", { lookup: async () => [PUBLIC, { address: "10.0.0.5", family: 4 }], get: async () => page("x") }));
});

test("isPublicAddress accepts ordinary public addresses", () => {
	assert.equal(isPublicAddress("93.184.216.34"), true);
	assert.equal(isPublicAddress("2606:2800:220:1:248:1893:25c8:1946"), true);
	assert.equal(isPublicAddress("172.32.0.1"), true);
});

test("a redirect to a private target is refused and a redirect to a public host is followed", async () => {
	await refused(fetchDocsText("https://docs.example/a", { lookup: async () => [PUBLIC], get: async () => redirect("http://169.254.169.254/latest/meta-data") }));

	const hosts: string[] = [];
	const text = await fetchDocsText("https://docs.example/a", {
		lookup: async () => [PUBLIC],
		get: async (url) => (hosts.push(url.host), hosts.length === 1 ? redirect("https://other.example/b") : page("<p>final</p>")),
	});
	assert.deepEqual(hosts, ["docs.example", "other.example"]);
	assert.equal(text, "final");
});

test("a redirect whose new host resolves to a private address is refused", async () => {
	const lookup = async (host: string) => (host === "evil.test" ? [{ address: "10.1.1.1", family: 4 as const }] : [PUBLIC]);
	await refused(fetchDocsText("https://docs.example/a", { lookup, get: async () => redirect("https://evil.test/x") }));
});

test("more than three redirects are refused", async () => {
	await refused(fetchDocsText("https://docs.example/a", { lookup: async () => [PUBLIC], get: async () => redirect("https://docs.example/again") }));
});

test("the connection uses the address that was checked, with one lookup per hop", async () => {
	let lookups = 0;
	let used: string | undefined;
	await fetchDocsText("https://docs.example/a", {
		lookup: async () => (lookups++, [PUBLIC]),
		get: async (_url, addr) => ((used = addr.address), page("ok")),
	});
	assert.equal(lookups, 1);
	assert.equal(used, PUBLIC.address);
});

test("a body over 1 MB is refused", async () => {
	const big = Readable.from([Buffer.alloc(600_000, 97), Buffer.alloc(600_000, 97)]);
	await refused(fetchDocsText("https://docs.example/a", { lookup: async () => [PUBLIC], get: async () => page("", { body: big }) }));
});

test("a non-text content type is refused", async () => {
	await refused(fetchDocsText("https://docs.example/a", { lookup: async () => [PUBLIC], get: async () => page("x", { headers: { "content-type": "application/pdf" } }) }));
});

test("a non-success status is refused", async () => {
	await refused(fetchDocsText("https://docs.example/a", { lookup: async () => [PUBLIC], get: async () => page("x", { status: 404 }) }));
});

test("a server that never answers times out", async () => {
	await refused(fetchDocsText("https://docs.example/a", { lookup: async () => [PUBLIC], get: () => new Promise(() => {}), timeoutMs: 20 }));
});

test("tags, scripts and styles are stripped from the page text", async () => {
	const html = "<html><head><style>p{color:red}</style><script>alert(1)</script></head><body><h1>Model</h1><p>Thinking: <b>low</b> &amp; high</p></body></html>";
	const text = await fetchDocsText("https://docs.example/a", { lookup: async () => [PUBLIC], get: async () => page(html) });
	assert.equal(text, "Model Thinking: low & high");
});
