import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { OAuthStore } from "./oauth-store.js";


function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(value));
}

function safeSecretEqual(a: string, b: string): boolean {
  const ah = createHash("sha256").update(a).digest();
  const bh = createHash("sha256").update(b).digest();
  return timingSafeEqual(ah, bh);
}

function validRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function trustedLegacyChatGptClient(clientId: string, redirectUri: string): boolean {
  if (!clientId.startsWith("nmc_")) return false;

  try {
    const url = new URL(redirectUri);
    if (url.protocol !== "https:") return false;

    const host = url.hostname.toLowerCase();
    return host === "chatgpt.com" || host.endsWith(".chatgpt.com");
  } catch {
    return false;
  }
}
export class OAuthService {


  constructor(
    private readonly publicBase: string,
    private readonly ownerKey: string,
    private readonly store = new OAuthStore()
  ) {}

  async initialize(): Promise<void> {
    await this.store.load();
  }

  challenge(res: ServerResponse): void {
    const metadataUrl = `${this.publicBase}/.well-known/oauth-protected-resource`;
    res.writeHead(401, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "www-authenticate": `Bearer resource_metadata="${metadataUrl}", scope="mcp"`
    });
    res.end(JSON.stringify({ error: "unauthorized" }));
  }

  async isAuthorized(req: IncomingMessage): Promise<boolean> {
    const auth = req.headers.authorization || "";
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    return !!(await this.store.verifyAccessToken(
      match[1].trim(),
      `${this.publicBase}/mcp`,
      ["mcp"]
    ));
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      json(res, 200, {
        resource: `${this.publicBase}/mcp`,
        authorization_servers: [this.publicBase],
        scopes_supported: ["mcp", "offline_access"],
        bearer_methods_supported: ["header"]
      });
      return true;
    }

    if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
      json(res, 200, {
        issuer: this.publicBase,
        authorization_endpoint: `${this.publicBase}/oauth/authorize`,
        token_endpoint: `${this.publicBase}/oauth/token`,
        registration_endpoint: `${this.publicBase}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        scopes_supported: ["mcp", "offline_access"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true
      });
      return true;
    }

    if (req.method === "POST" && url.pathname === "/oauth/register") {
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { json(res, 400, { error: "invalid_client_metadata" }); return true; }

      const redirectUris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris.filter((value: unknown): value is string => typeof value === "string" && validRedirectUri(value))
        : [];
      if (redirectUris.length === 0 || redirectUris.length !== body.redirect_uris?.length) {
        json(res, 400, { error: "invalid_redirect_uri" });
        return true;
      }

      const client = await this.store.registerClient({
        redirectUris,
        clientName: typeof body.client_name === "string" ? body.client_name : undefined
      });

      json(res, 201, {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      });
      return true;
    }

    if (req.method === "GET" && url.pathname === "/oauth/authorize") {
      const clientId = url.searchParams.get("client_id") || "";
      const redirectUri = url.searchParams.get("redirect_uri") || "";
      const state = url.searchParams.get("state") || "";
      const codeChallenge = url.searchParams.get("code_challenge") || "";
      const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "";
      const scope = url.searchParams.get("scope") || "mcp offline_access";
      const resource = url.searchParams.get("resource") || `${this.publicBase}/mcp`;

      const client = await this.store.getClient(clientId);
      const legacyClientAllowed = !client && trustedLegacyChatGptClient(clientId, redirectUri);
      if ((!client && !legacyClientAllowed) || (client && !client.redirectUris.includes(redirectUri))) {
        json(res, 400, { error: "invalid_request", error_description: "Unknown client or redirect URI" });
        return true;
      }
      if (!codeChallenge || codeChallengeMethod !== "S256") {
        json(res, 400, { error: "invalid_request", error_description: "PKCE S256 is required" });
        return true;
      }
      if (resource !== `${this.publicBase}/mcp`) {
        json(res, 400, { error: "invalid_target", error_description: "Unknown OAuth resource" });
        return true;
      }
      if (!scope.split(/\s+/).includes("mcp")) {
        json(res, 400, { error: "invalid_scope", error_description: "The mcp scope is required" });
        return true;
      }

      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize Nomsod MCP</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:0;min-height:100vh;display:grid;place-items:center}
main{width:min(440px,calc(100% - 32px));background:#1e293b;border:1px solid #334155;border-radius:14px;padding:28px;box-sizing:border-box}
h1{font-size:22px;margin:0 0 12px}p{color:#94a3b8;line-height:1.5}label{display:block;margin-top:20px;font-weight:600}
input{width:100%;box-sizing:border-box;margin-top:8px;padding:12px;border-radius:8px;border:1px solid #475569;background:#0f172a;color:white}
button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:8px;background:#2563eb;color:white;font-weight:700}
</style>
</head>
<body><main>
<h1>Authorize Nomsod MCP</h1>
<p>Allow this ChatGPT MCP client to access computers connected to your Nomsod Gateway.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="client_id" value="${htmlEscape(clientId)}">
<input type="hidden" name="redirect_uri" value="${htmlEscape(redirectUri)}">
<input type="hidden" name="state" value="${htmlEscape(state)}">
<input type="hidden" name="code_challenge" value="${htmlEscape(codeChallenge)}">
<input type="hidden" name="scope" value="${htmlEscape(scope)}">
<input type="hidden" name="resource" value="${htmlEscape(resource)}">
<label>Owner key</label>
<input type="password" name="owner_key" autocomplete="current-password" required autofocus>
<button type="submit">Authorize ChatGPT</button>
</form></main></body></html>`;

      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(html);
      return true;
    }

    if (req.method === "POST" && url.pathname === "/oauth/authorize") {
      const params = new URLSearchParams(await readBody(req));
      const ownerKey = params.get("owner_key") || "";
      const clientId = params.get("client_id") || "";
      const redirectUri = params.get("redirect_uri") || "";
      const state = params.get("state") || "";
      const codeChallenge = params.get("code_challenge") || "";
      const scope = params.get("scope") || "mcp offline_access";
      const resource = params.get("resource") || `${this.publicBase}/mcp`;

      if (!this.ownerKey || !safeSecretEqual(ownerKey, this.ownerKey)) {
        res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end("<h3>Authorization denied.</h3>");
        return true;
      }

      let client = await this.store.getClient(clientId);
      if (!client && trustedLegacyChatGptClient(clientId, redirectUri)) {
        client = await this.store.adoptLegacyClient(clientId, redirectUri);
      }
      if (!client || !client.redirectUris.includes(redirectUri) || !codeChallenge) {
        json(res, 400, { error: "invalid_request" });
        return true;
      }
      if (resource !== `${this.publicBase}/mcp` || !scope.split(/\s+/).includes("mcp")) {
        json(res, 400, { error: "invalid_target" });
        return true;
      }

      const code = await this.store.issueAuthorizationCode({
        clientId,
        redirectUri,
        codeChallenge,
        scope,
        resource,
        expiresAt: Date.now() + 5 * 60_000
      });

      const callback = new URL(redirectUri);
      callback.searchParams.set("code", code);
      if (state) callback.searchParams.set("state", state);
      callback.searchParams.set("iss", this.publicBase);
      res.writeHead(302, { location: callback.toString(), "cache-control": "no-store" });
      res.end();
      return true;
    }

    if (req.method === "POST" && url.pathname === "/oauth/token") {
      const raw = await readBody(req);
      let params: URLSearchParams;
      try {
        if ((req.headers["content-type"] || "").includes("application/json")) {
          const parsed = JSON.parse(raw);
          params = new URLSearchParams(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
        } else {
          params = new URLSearchParams(raw);
        }
      } catch {
        json(res, 400, { error: "invalid_request" });
        return true;
      }

      const grantType = params.get("grant_type") || "";
      const clientId = params.get("client_id") || "";
      const resource = params.get("resource") || `${this.publicBase}/mcp`;

      if (resource !== `${this.publicBase}/mcp`) {
        json(res, 400, { error: "invalid_target" });
        return true;
      }

      if (grantType === "refresh_token") {
        const rotated = await this.store.rotateRefreshToken(
          params.get("refresh_token") || "",
          clientId || undefined,
          resource
        );
        if (!rotated) {
          json(res, 400, { error: "invalid_grant" });
          return true;
        }
        json(res, 200, {
          access_token: rotated.accessToken,
          token_type: "Bearer",
          expires_in: rotated.expiresIn,
          refresh_token: rotated.refreshToken,
          scope: rotated.scope
        });
        return true;
      }

      if (grantType !== "authorization_code") {
        json(res, 400, { error: "unsupported_grant_type" });
        return true;
      }

      const code = params.get("code") || "";
      const record = await this.store.consumeAuthorizationCode(code);
      if (!record) {
        json(res, 400, { error: "invalid_grant" });
        return true;
      }

      const redirectUri = params.get("redirect_uri") || "";
      const verifier = params.get("code_verifier") || "";
      if (
        record.clientId !== clientId ||
        record.redirectUri !== redirectUri ||
        record.resource !== resource ||
        !verifier
      ) {
        json(res, 400, { error: "invalid_grant" });
        return true;
      }

      const expected = createHash("sha256").update(verifier).digest("base64url");
      if (expected !== record.codeChallenge) {
        json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        return true;
      }

      const tokens = await this.store.issueTokens(record.clientId, record.scope, record.resource);
      json(res, 200, {
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
        scope: record.scope
      });
      return true;
    }

    return false;
  }
}
