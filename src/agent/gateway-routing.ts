import { URL } from "node:url";

export function isFallbackGatewayUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "wss:";
  } catch {
    return false;
  }
}

export function hasConnectedPrimaryGateway(urls: Iterable<string>): boolean {
  for (const url of urls) {
    if (!isFallbackGatewayUrl(url)) return true;
  }
  return false;
}
