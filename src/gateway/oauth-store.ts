import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface OAuthClientRecord {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: string;
}

interface TokenRecord {
  clientId: string;
  scope: string;
  expiresAt: number;
}

interface OAuthStoreFile {
  clients: Record<string, OAuthClientRecord>;
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
}

export class OAuthStore {
  private data: OAuthStoreFile = { clients: {}, accessTokens: {}, refreshTokens: {} };
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file = process.env.NOMSOD_OAUTH_STORE_PATH || path.resolve("data", "oauth.json")
  ) {}

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

  async registerClient(input: { redirectUris: string[]; clientName?: string }): Promise<OAuthClientRecord> {
    await this.load();
    const clientId = "nmc_" + randomBytes(24).toString("base64url");
    const record: OAuthClientRecord = {
      clientId,
      redirectUris: [...new Set(input.redirectUris)],
      clientName: input.clientName,
      createdAt: new Date().toISOString()
    };
    this.data.clients[clientId] = record;
    await this.persist();
    return record;
  }

  async getClient(clientId: string): Promise<OAuthClientRecord | undefined> {
    await this.load();
    return this.data.clients[clientId];
  }

  async issueTokens(clientId: string, scope: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    await this.load();
    const accessToken = "nma_" + randomBytes(32).toString("base64url");
    const refreshToken = "nmr_" + randomBytes(40).toString("base64url");
    const expiresIn = 3600;
    this.data.accessTokens[this.hash(accessToken)] = {
      clientId,
      scope,
      expiresAt: Date.now() + expiresIn * 1000
    };
    this.data.refreshTokens[this.hash(refreshToken)] = {
      clientId,
      scope,
      expiresAt: Date.now() + 30 * 24 * 3600 * 1000
    };
    await this.persist();
    return { accessToken, refreshToken, expiresIn };
  }

  async rotateRefreshToken(refreshToken: string, clientId?: string): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    scope: string;
  } | undefined> {
    await this.load();
    const key = this.hash(refreshToken);
    const record = this.data.refreshTokens[key];
    if (!record || record.expiresAt <= Date.now()) return undefined;
    if (clientId && record.clientId !== clientId) return undefined;
    delete this.data.refreshTokens[key];

    const next = await this.issueTokens(record.clientId, record.scope);
    return { ...next, scope: record.scope };
  }

  async verifyAccessToken(accessToken: string): Promise<TokenRecord | undefined> {
    await this.load();
    const record = this.data.accessTokens[this.hash(accessToken)];
    if (!record || record.expiresAt <= Date.now()) return undefined;
    return record;
  }
}
