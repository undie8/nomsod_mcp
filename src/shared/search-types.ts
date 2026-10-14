export interface SearchParams {
  query: string;
  path?: string;
  pattern?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
}

export interface SearchMatch {
  file: string;
  line: number;
  column: number;
  preview: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  totalMatches: number;
  totalFilesScanned: number;
  durationMs: number;
  truncated: boolean;
}
