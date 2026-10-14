export interface ReadImageParams {
  path: string;
}

export interface ImageResult {
  base64: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
}

export interface ScreenshotParams {
  screenMode?: "primary" | "virtual";
}

export interface ScreenshotResult extends ImageResult {
  capturedAt: number;
}
