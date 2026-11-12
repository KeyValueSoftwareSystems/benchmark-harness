// Every call the page makes. No browser storage, no URL state: keys travel in request bodies only.

async function call(method, path, body) {
	const res = await fetch(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	let json;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {}
	if (!res.ok) throw Object.assign(new Error(json?.error ?? `request failed (${res.status})`), { status: res.status });
	return json;
}

export const api = {
	models: () => call("GET", "/models"),
	benchmarks: () => call("GET", "/benchmarks"),
	addModel: (model) => call("POST", "/models", model),
	removeModel: (name) => call("DELETE", `/models/${encodeURIComponent(name)}`),
	setKey: (name, apiKey) => call("PUT", `/models/${encodeURIComponent(name)}/key`, { apiKey }),
	discover: (docsUrl) => call("POST", "/models/discover", { docsUrl }),
	jobs: () => call("GET", "/jobs"),
	/** `challenges` is "all" or a list of challenge ids; `prompt` is for benchmarks that take one. */
	startRun: ({ benchmark, model, challenges, prompt }) =>
		call("POST", "/jobs", { benchmark, models: [model], ...(Array.isArray(challenges) ? { challenges } : benchmark === "cyber" ? { challenge: "all" } : {}), ...(prompt ? { prompt } : {}) }),
	run: (runId) => call("GET", `/runs/${encodeURIComponent(runId)}`),
	cancelRun: (runId) => call("POST", `/runs/${encodeURIComponent(runId)}/cancel`),
	buildReport: (benchmark, models) => call("POST", "/reports", { benchmark, models }),
	reportUrl: (id) => `/reports/${encodeURIComponent(id)}`,
};
