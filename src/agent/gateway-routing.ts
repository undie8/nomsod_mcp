import { URL } from "node:url";

export function isFallbackGatewayUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "wss:";
  } catch {
    return false;
  }
}

export function isLoopbackGatewayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]"
    );
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

export function shouldParkFallbackGateway(
  fallbackUrl: string,
  connectedGateways: Iterable<string>,
  hubIdByUrl?: ReadonlyMap<string, string>
): boolean {
  if (!isFallbackGatewayUrl(fallbackUrl)) return false;

  const fallbackHubId = hubIdByUrl?.get(fallbackUrl);
  if (!fallbackHubId) {
    return hasConnectedPrimaryGateway(connectedGateways);
  }

  for (const connectedUrl of connectedGateways) {
    if (connectedUrl === fallbackUrl) continue;
    if (isFallbackGatewayUrl(connectedUrl)) continue;

    const connectedHubId = hubIdByUrl?.get(connectedUrl);
    if (connectedHubId && connectedHubId === fallbackHubId) {
      return true;
    }
  }

  return false;
}
