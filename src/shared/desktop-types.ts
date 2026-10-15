export type MouseButton = "left" | "right" | "middle";

export interface DesktopClickParams {
  x?: number;
  y?: number;
  button?: MouseButton;
  double?: boolean;
}

export interface DesktopClickResult {
  ok: boolean;
  x: number;
  y: number;
  button: MouseButton;
  double: boolean;
  error?: string;
}

export interface DesktopMouseMoveParams {
  x: number;
  y: number;
}

export interface DesktopMouseMoveResult {
  ok: boolean;
  x: number;
  y: number;
  error?: string;
}

export interface DesktopCursorPositionResult {
  ok: boolean;
  x: number;
  y: number;
  error?: string;
}

export interface DesktopTypeParams {
  text: string;
  delayMs?: number;
}

export interface DesktopTypeResult {
  ok: boolean;
  text: string;
  length: number;
  error?: string;
}

export type KeyModifier = "ctrl" | "alt" | "shift" | "meta" | "cmd";

export interface DesktopKeyPressParams {
  key: string;
  modifiers?: KeyModifier[];
}

export interface DesktopKeyPressResult {
  ok: boolean;
  key: string;
  modifiers?: KeyModifier[];
  error?: string;
}

export interface WindowInfo {
  id: string | number;
  title: string;
  processName: string;
  pid?: number;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface DesktopListWindowsParams {
  filter?: string;
}

export interface DesktopListWindowsResult {
  ok: boolean;
  windows: WindowInfo[];
  error?: string;
}

export interface DesktopFocusWindowParams {
  id?: string | number;
  title?: string;
  processName?: string;
}

export interface DesktopFocusWindowResult {
  ok: boolean;
  focused: boolean;
  window?: WindowInfo;
  error?: string;
}
