import { describe, expect, it } from "vitest";
import http from "node:http";
import { URL } from "node:url";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { OAuthService } from "../src/gateway/oauth.js";
import { OAuthStore } from "../src/gateway/oauth-store.js";

class MockResponse extends EventEmitter {
  statusCode = 200;
  headers: Record<string, string> = {};
  body = "";

  writeHead(statusCode: number, headers: Record<string, string> = {}) {
    this.statusCode = statusCode;
    Object.assign(this.headers, headers);
    return this;
  }

  end(chunk?: string) {
    if (chunk) this.body += chunk;
    this.emit("finish");
    return this;
  }
}

function createMockReq(options: {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): http.IncomingMessage {
  const stream = Readable.from(options.body ? [Buffer.from(options.body)] : []);
  const req = stream as any;
  req.method = options.method || "GET";
  req.url = options.url;
  req.headers = { ...(options.headers || {}) };
  return req;
}

describe("OAuth 2.0 Confidential Client (Gemini Enterprise)", () => {
  const publicBase = "https://mcp.nomsod.net";
  const ownerKey = "test-owner-key-12345";

  it("provides durable Gemini Enterprise credentials", async () => {
    const store = new OAuthStore(undefined, "test-cluster-key");
    await store.load();

    const creds = store.getGeminiCredentials();
    expect(creds.clientId).toBe("gemini-enterprise");
    expect(creds.clientSecret).toMatch(/^ngs_/);

    const client = await store.getClient("gemini-enterprise");
    expect(client).toBeDefined();
    expect(client?.clientId).toBe("gemini-enterprise");
    expect(client?.clientSecret).toBe(creds.clientSecret);
    expect(client?.clientName).toBe("Gemini Enterprise");
  });

  it("allows Gemini Enterprise authorization without PKCE to trusted Google redirects", async () => {
    const service = new OAuthService(publicBase, ownerKey);
    await service.initialize();

    const redirectUri = "https://oauth-redirect.googleusercontent.com/r/my-gemini-app";
    const req = createMockReq({
      method: "GET",
      url: `/oauth/authorize?client_id=gemini-enterprise&redirect_uri=${encodeURIComponent(
        redirectUri
      )}&state=xyz123&scope=mcp`
    });
    const res = new MockResponse();

    const handled = await service.handle(req, res as any, new URL(req.url!, publicBase));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Authorize Gemini Enterprise");
  });

  it("rejects unauthorized redirect URIs for Gemini Enterprise", async () => {
    const service = new OAuthService(publicBase, ownerKey);
    await service.initialize();

    const req = createMockReq({
      method: "GET",
      url: `/oauth/authorize?client_id=gemini-enterprise&redirect_uri=https://attacker.example.com/callback&state=xyz123&scope=mcp`
    });
    const res = new MockResponse();

    const handled = await service.handle(req, res as any, new URL(req.url!, publicBase));
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Unknown client or redirect URI");
  });

  it("completes full code exchange with client_secret in request body", async () => {
    const service = new OAuthService(publicBase, ownerKey);
    await service.initialize();
    const creds = service.getGeminiCredentials();

    const redirectUri = "https://oauth-redirect.googleusercontent.com/r/gemini-app";

    // 1. POST /oauth/authorize (owner approves)
    const authBody = new URLSearchParams({
      owner_key: ownerKey,
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      state: "state-123",
      scope: "mcp"
    }).toString();

    const authReq = createMockReq({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: authBody
    });
    const authRes = new MockResponse();
    await service.handle(authReq, authRes as any, new URL(authReq.url!, publicBase));

    expect(authRes.statusCode).toBe(302);
    const location = new URL(authRes.headers["location"]);
    const code = location.searchParams.get("code")!;
    expect(code).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("state-123");

    // 2. POST /oauth/token with wrong client_secret -> 401
    const badTokenReq = createMockReq({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: creds.clientId,
        client_secret: "wrong-secret",
        redirect_uri: redirectUri
      }).toString()
    });
    const badTokenRes = new MockResponse();
    await service.handle(badTokenReq, badTokenRes as any, new URL(badTokenReq.url!, publicBase));
    expect(badTokenRes.statusCode).toBe(401);

    // 3. POST /oauth/token with correct client_secret -> 200 with tokens
    const goodTokenReq = createMockReq({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: redirectUri
      }).toString()
    });
    const goodTokenRes = new MockResponse();
    await service.handle(goodTokenReq, goodTokenRes as any, new URL(goodTokenReq.url!, publicBase));

    expect(goodTokenRes.statusCode).toBe(200);
    const tokenData = JSON.parse(goodTokenRes.body);
    expect(tokenData.token_type).toBe("Bearer");
    expect(tokenData.access_token).toBeTruthy();
    expect(tokenData.refresh_token).toBeTruthy();

    // 4. Verify access token authorizes protected requests
    const verifyReq = createMockReq({
      url: "/mcp",
      headers: { authorization: `Bearer ${tokenData.access_token}` }
    });
    const isAuth = await service.isAuthorized(verifyReq);
    expect(isAuth).toBe(true);

    // 5. Rotate refresh token with client_secret
    const refreshReq = createMockReq({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokenData.refresh_token,
        client_id: creds.clientId,
        client_secret: creds.clientSecret
      }).toString()
    });
    const refreshRes = new MockResponse();
    await service.handle(refreshReq, refreshRes as any, new URL(refreshReq.url!, publicBase));
    expect(refreshRes.statusCode).toBe(200);
    const refreshed = JSON.parse(refreshRes.body);
    expect(refreshed.access_token).toBeTruthy();
  });

  it("supports Basic HTTP authentication for client credentials", async () => {
    const service = new OAuthService(publicBase, ownerKey);
    await service.initialize();
    const creds = service.getGeminiCredentials();

    const redirectUri = "https://oauth-redirect.googleusercontent.com/r/gemini-app";

    // Issue auth code
    const authBody = new URLSearchParams({
      owner_key: ownerKey,
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      scope: "mcp"
    }).toString();
    const authReq = createMockReq({
      method: "POST",
      url: "/oauth/authorize",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: authBody
    });
    const authRes = new MockResponse();
    await service.handle(authReq, authRes as any, new URL(authReq.url!, publicBase));
    const location = new URL(authRes.headers["location"]);
    const code = location.searchParams.get("code")!;

    // POST /oauth/token using Authorization: Basic
    const basicAuth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
    const tokenReq = createMockReq({
      method: "POST",
      url: "/oauth/token",
      headers: {
        authorization: `Basic ${basicAuth}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri
      }).toString()
    });
    const tokenRes = new MockResponse();
    await service.handle(tokenReq, tokenRes as any, new URL(tokenReq.url!, publicBase));

    expect(tokenRes.statusCode).toBe(200);
    const tokenData = JSON.parse(tokenRes.body);
    expect(tokenData.access_token).toBeTruthy();
  });
});
