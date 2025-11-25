export interface SymbolLocation {
  uri: string;
  line: number;
  character: number;
}

export interface IndexedSymbol {
  name: string;
  kind: string;
  location: SymbolLocation;
  containerName?: string;
}

export interface IndexedFileResult {
  uri: string;
  hash: string;
  symbols: IndexedSymbol[];
}

export interface FileInfo {
  uri: string;
  hash: string;
  lastIndexedAt: number;
}

export interface Metadata {
  version: number;
  lastGitHash?: string;
  lastUpdatedAt: number;
}

export interface IndexStats {
  totalFiles: number;
  totalSymbols: number;
  cacheHits: number;
  cacheMisses: number;
  lastUpdateTime: number;
}
