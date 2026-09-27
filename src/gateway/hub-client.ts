export interface ComputerHub {
  listDevices(): Promise<unknown> | unknown;
  request(deviceId: string, method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  reloadRuntime?(): Promise<unknown>;
  rollbackRuntime?(): Promise<unknown>;
  runtimeStatus?(): Promise<unknown>;
}

export class RemoteComputerHub implements ComputerHub {
  constructor(
    private readonly controlBase: string,
    private readonly controlKey: string
  ) {}

  private async call(path: string, init?: RequestInit): Promise<any> {
    const response = await fetch(new URL(path, this.controlBase), {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-nomsod-control-key": this.controlKey,
        ...(init?.headers || {})
      },
      signal: AbortSignal.timeout(310_000)
    });

    const text = await response.text();
    let body: any;
    try { body = text ? JSON.parse(text) : {}; }
    catch { body = { error: text || `HTTP ${response.status}` }; }

    if (!response.ok) {
      throw new Error(body?.error || body?.message || `Control request failed: HTTP ${response.status}`);
    }
    return body;
  }

  async listDevices(): Promise<unknown> {
    const result = await this.call("/devices");
    return result.devices || [];
  }

  async request(deviceId: string, method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const result = await this.call("/request", {
      method: "POST",
      body: JSON.stringify({ deviceId, method, params, timeoutMs })
    });
    return result.result;
  }

  async reloadRuntime(): Promise<unknown> {
    return this.call("/reload", { method: "POST", body: "{}" });
  }

  async rollbackRuntime(): Promise<unknown> {
    return this.call("/rollback", { method: "POST", body: "{}" });
  }

  async runtimeStatus(): Promise<unknown> {
    return this.call("/runtime");
  }
}
