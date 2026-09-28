export const DEFAULT_CLUSTER_ID = "nomsod-main-v1";

export function resolveClusterId(): string {
  const configured = (process.env.NOMSOD_CLUSTER_ID || "").trim();
  const value = configured || DEFAULT_CLUSTER_ID;

  if (!/^[a-z0-9][a-z0-9._:-]{2,127}$/i.test(value)) {
    throw new Error("NOMSOD_CLUSTER_ID contains unsupported characters.");
  }

  return value;
}
