import { loadDotEnv } from "./env.js";
import { installFileLogging } from "./logging.js";

const envFile = await loadDotEnv();
const logFile = installFileLogging("agent");

console.log("[bootstrap] role=agent-guardian");
console.log(`[bootstrap] cwd=${process.cwd()}`);
console.log(`[bootstrap] env=${envFile || "(none)"}`);
console.log(`[bootstrap] log=${logFile}`);

await import("../agent/main.js");
