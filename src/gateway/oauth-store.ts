import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, promises as fs, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveClusterKey, signClusterToken, verifyClusterToken } from "../shared/cluster-token.js";

export interface OAuthClientRecord {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  clientSecret?: string;
  createdAt: string;
}

export interface AuthCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

interface TokenRecord {
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

interface OAuthStoreFile {
  clients: Record<string, OAuthClientRecord>;
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
}

interface ClusterClientPayload {
  redirectUris: string[];
  clientName?: string;
  clientSecret?: string;
  createdAt: string;
}

interface ClusterTokenPayload {
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

function loadOrCreateGeminiClientSecret(rootDir: string = process.cwd()): string {
  const configured = (process.env.NOMSOD_GEMINI_CLIENT_SECRET || "").trim();
  if (configured) return configured;

  const secretPath =
    process.env.NOMSOD_GEMINI_CLIENT_SECRET_PATH ||
    path.resolve(rootDir, "data", "gemini-client.secret");

  try {
    if (existsSync(secretPath)) {
      const existing = readFileSync(secretPath, "utf8").trim();
      if (existing) return existing;
    }
  } catch {}

  const generated = "ngs_" + randomBytes(24).toString("base64url");
  mkdirSync(path.dirname(secretPath), { recursive: true });
  writeFileSync(secretPath, generated + "\n", { encoding: "utf8", mode: 0o600 });
  try { chmodSync(secretPath, 0o600); } catch {}
  return generated;
}

export class OAuthStore {
  private data: OAuthStoreFile = { clients: {}, accessTokens: {}, refreshTokens: {} };
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly authCodes = new Map<string, AuthCodeRecord>();
  private readonly geminiClientId: string;
  private readonly geminiClientSecret: string;

  constructor(
    private readonly file = process.env.NOMSOD_OAUTH_STORE_PATH || path.resolve("data", "oauth.json"),
    private readonly clusterKey = resolveClusterKey(),
    private readonly rootDir = process.cwd()
  ) {
    this.geminiClientId = (process.env.NOMSOD_GEMINI_CLIENT_ID || "gemini-enterprise").trim();
    this.geminiClientSecret = loadOrCreateGeminiClientSecret(this.rootDir);
  }

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as OAuthStoreFile;
      this.data = {
        clients: parsed.clients || {},
        accessTokens: parsed.accessTokens || {},
        refreshTokens: parsed.refreshTokens || {}
      };
    } catch {
      this.data = { clients: {}, accessTokens: {}, refreshTokens: {} };
    }
    this.prune();
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, record] of Object.entries(this.data.accessTokens)) {
      if (record.expiresAt <= now) delete this.data.accessTokens[key];
    }
    for (const [key, record] of Object.entries(this.data.refreshTokens)) {
      if (record.expiresAt <= now) delete this.data.refreshTokens[key];
    }
    for (const [key, record] of this.authCodes) {
      if (record.expiresAt <= now) this.authCodes.delete(key);
    }
  }

  private async persist(): Promise<void> {
    this.prune();
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      await fs.writeFile(tmp, snapshot, { encoding: "utf8", mode: 0o600 });
      try { await fs.chmod(tmp, 0o600); } catch {}
      try { await fs.rm(this.file, { force: true }); } catch {}
      await fs.rename(tmp, this.file);
    });
    return this.writeChain;
  }

  async registerClient(input: {
    redirectUris: string[];
    clientName?: string;
    clientSecret?: string;
  }): Promise<OAuthClientRecord> {
    await this.load();
    const createdAt = new Date().toISOString();

    if (this.clusterKey) {
      const payload: ClusterClientPayload = {
        redirectUris: [...new Set(input.redirectUris)],
        clientName: input.clientName,
        clientSecret: input.clientSecret,
        createdAt
      };
      const clientId = signClusterToken("nmc2", payload, this.clusterKey);
      return { clientId, ...payload };
    }

    const clientId = "nmc_" + randomBytes(24).toString("base64url");
    const record: OAuthClientRecord = {
      clientId,
      redirectUris: [...new Set(input.redirectUris)],
      clientName: input.clientName,
      clientSecret: input.clientSecret,
      createdAt
    };
    this.data.clients[clientId] = record;
    await this.persist();
    return record;
  }

  async adoptLegacyClient(
    clientId: string,
    redirectUri: string,
    clientName = "ChatGPT legacy client"
  ): Promise<OAuthClientRecord> {
    await this.load();

    const existing = this.data.clients[clientId];
    if (existing) {
      if (!existing.redirectUris.includes(redirectUri)) {
        existing.redirectUris.push(redirectUri);
        await this.persist();
      }
      return existing;
    }

    const record: OAuthClientRecord = {
      clientId,
      redirectUris: [redirectUri],
      clientName,
      createdAt: new Date().toISOString()
    };
    this.data.clients[clientId] = record;
    await this.persist();
    return record;
  }

  async getClient(clientId: string): Promise<OAuthClientRecord | undefined> {
    await this.load();

    if (clientId && clientId === this.geminiClientId) {
      return {
        clientId: this.geminiClientId,
        clientSecret: this.geminiClientSecret,
        clientName: "Gemini Enterprise",
        redirectUris: [],
        createdAt: "2026-10-14T00:00:00.000Z"
      };
    }

    if (this.clusterKey && clientId.startsWith("nmc2.")) {
      const payload = verifyClusterToken<ClusterClientPayload>(clientId, "nmc2", this.clusterKey);
      if (!payload || !Array.isArray(payload.redirectUris)) return undefined;
      return {
        clientId,
        redirectUris: payload.redirectUris,
        clientName: payload.clientName,
        clientSecret: payload.clientSecret,
        createdAt: payload.createdAt
      };
    }

    return this.data.clients[clientId];
  }

  getGeminiCredentials(): { clientId: string; clientSecret: string } {
    return {
      clientId: this.geminiClientId,
      clientSecret: this.geminiClientSecret
    };
  }

  async issueAuthorizationCode(record: AuthCodeRecord): Promise<string> {
    await this.load();

    if (this.clusterKey) {
      const ttlSeconds = Math.max(1, Math.ceil((record.expiresAt - Date.now()) / 1000));
      return signClusterToken("nac2", record, this.clusterKey, ttlSeconds);
    }

    const code = "nmc_code_" + randomBytes(24).toString("base64url");
    this.authCodes.set(code, record);
    return code;
  }

  async consumeAuthorizationCode(code: string): Promise<AuthCodeRecord | undefined> {
    await this.load();

    if (this.clusterKey && code.startsWith("nac2.")) {
      const record = verifyClusterToken<AuthCodeRecord>(code, "nac2", this.clusterKey);
      if (!record || record.expiresAt <= Date.now()) return undefined;
      return record;
    }

    const record = this.authCodes.get(code);
    this.authCodes.delete(code);
    if (!record || record.expiresAt <= Date.now()) return undefined;
    return record;
  }

  async issueTokens(clientId: string, scope: string, resource: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    await this.load();
    const expiresIn = 3600;

    if (this.clusterKey) {
      const accessPayload: ClusterTokenPayload = {
        clientId,
        scope,
        resource,
        expiresAt: Date.now() + expiresIn * 1000
      };
      const refreshPayload: ClusterTokenPayload = {
        clientId,
        scope,
        resource,
        expiresAt: Date.now() + 30 * 24 * 3600 * 1000
      };
      return {
        accessToken: signClusterToken("nma2", accessPayload, this.clusterKey, expiresIn),
        refreshToken: signClusterToken("nmr2", refreshPayload, this.clusterKey, 30 * 24 * 3600),
        expiresIn
      };
    }

    const accessToken = "nma_" + randomBytes(32).toString("base64url");
    const refreshToken = "nmr_" + randomBytes(40).toString("base64url");
    this.data.accessTokens[this.hash(accessToken)] = {
      clientId,
      scope,
      resource,
      expiresAt: Date.now() + expiresIn * 1000
    };
    this.data.refreshTokens[this.hash(refreshToken)] = {
      clientId,
      scope,
      resource,
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000
    };
    await this.persist();
    return { accessToken, refreshToken, expiresIn };
  }

  async rotateRefreshToken(refreshToken: string, clientId?: string, resource?: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    scope: string;
    resource: string;
  } | undefined> {
    await this.load();

    if (this.clusterKey && refreshToken.startsWith("nmr2.")) {
      const record = verifyClusterToken<ClusterTokenPayload>(refreshToken, "nmr2", this.clusterKey);
      if (!record || record.expiresAt <= Date.now()) return undefined;
      if (clientId && record.clientId !== clientId) return undefined;
      if (resource && record.resource !== resource) return undefined;

      const next = await this.issueTokens(record.clientId, record.scope, record.resource);
      return { ...next, scope: record.scope, resource: record.resource };
    }

    const key = this.hash(refreshToken);
    const record = this.data.refreshTokens[key];
    if (!record || record.expiresAt <= Date.now()) return undefined;
    if (clientId && record.clientId !== clientId) return undefined;
    if (resource && record.resource !== resource) return undefined;
    delete this.data.refreshTokens[key];
    await this.persist();

    const next = await this.issueTokens(record.clientId, record.scope, record.resource);
    return { ...next, scope: record.scope, resource: record.resource };
  }

  async verifyAccessToken(
    accessToken: string,
    resource?: string,
    requiredScopes: string[] = []
  ): Promise<TokenRecord | undefined> {
    await this.load();

    let record: TokenRecord | undefined;

    if (this.clusterKey && accessToken.startsWith("nma2.")) {
      record = verifyClusterToken<ClusterTokenPayload>(accessToken, "nma2", this.clusterKey);
    } else {
      record = this.data.accessTokens[this.hash(accessToken)];
    }

    if (!record || record.expiresAt <= Date.now()) return undefined;
    if (resource && record.resource !== resource) return undefined;

    const granted = new Set(record.scope.split(/\s+/).filter(Boolean));
    if (requiredScopes.some(scope => !granted.has(scope))) return undefined;

    return record;
  }
}
