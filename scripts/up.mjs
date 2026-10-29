// Usage: npm run up -- <benchmark...>
// Starts the api plus one replica of each benchmark service per model in MODELS (from .env).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const benchmarks = process.argv.slice(2);
if (!benchmarks.length) {
	console.error("usage: npm run up -- <benchmark...>");
	process.exit(1);
}
const line = readFileSync(".env", "utf8")
	.split("\n")
	.find((l) => l.startsWith("MODELS="));
if (!line) {
	console.error("MODELS is not set in .env");
	process.exit(1);
}
const raw = line.slice("MODELS=".length).trim().replace(/^'(.*)'$/s, "$1");
const count = JSON.parse(raw).length;
const scale = benchmarks.flatMap((b) => ["--scale", `${b}=${count}`]);
const { status } = spawnSync("docker", ["compose", "up", "--build", "api", ...benchmarks, ...scale], {
	stdio: "inherit",
});
process.exit(status ?? 1);
