export interface BrowserNavigateParams {
  url: string;
  timeoutMs?: number;
}

export interface BrowserNavigateResult {
  ok: boolean;
  url: string;
  title: string;
}

export interface BrowserClickParams {
  selector: string;
  timeoutMs?: number;
}

export interface BrowserClickResult {
  ok: boolean;
  selector: string;
}

export interface BrowserTypeParams {
  selector: string;
  text: string;
  clearFirst?: boolean;
}

export interface BrowserTypeResult {
  ok: boolean;
  selector: string;
  textLength: number;
}

export interface BrowserConsoleLog {
  type: "log" | "warn" | "error" | "info";
  text: string;
  timestamp: number;
}

export interface BrowserSnapshotParams {
  maxDepth?: number;
}

export interface BrowserSnapshotResult {
  url: string;
  title: string;
  htmlSnippet: string;
  consoleLogs: BrowserConsoleLog[];
  hasErrors: boolean;
}

export interface BrowserScreenshotParams {
  fullPage?: boolean;
}

export interface BrowserScreenshotResult {
  base64: string;
  mimeType: "image/png";
  bytes: number;
  width?: number;
  height?: number;
}

export interface BrowserCloseResult {
  ok: boolean;
  message: string;
}
