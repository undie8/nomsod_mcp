import { loadDotEnv } from "./env.js";
import { installFileLogging } from "./logging.js";

const envFile = await loadDotEnv();
const logFile = installFileLogging("supervisor");

console.log("[bootstrap] role=supervisor");
console.log(`[bootstrap] cwd=${process.cwd()}`);
console.log(`[bootstrap] env=${envFile || "(none)"}`);
console.log(`[bootstrap] log=${logFile}`);

await import("../supervisor/main.js");
