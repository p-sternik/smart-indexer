export interface SymbolLocation {
  uri: string;
  line: number;
  character: number;
}

export interface SymbolRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface NgRxMetadata {
  type: string; // The NgRx type string, e.g., '[Products Page] Load'
  role: 'action' | 'effect' | 'reducer';
  isGroup?: boolean; // true if this is a createActionGroup container
  events?: Record<string, string>; // For action groups: camelCase method -> 'Event String'
}

export interface IndexedSymbol {
  id: string; // stable symbol identifier
  name: string;
  kind: string;
  location: SymbolLocation;
  range: SymbolRange;
  containerName?: string;
  containerKind?: string;
  fullContainerPath?: string; // e.g. "ng.forms.CompatFieldAdapter"
  filePath: string;
  isStatic?: boolean;
  parametersCount?: number;
  ngrxMetadata?: NgRxMetadata; // NgRx-specific information
}

export interface IndexedReference {
  symbolName: string; // name of the referenced symbol
  location: SymbolLocation;
  range: SymbolRange;
  containerName?: string; // context where usage occurs
  isImport?: boolean; // true if part of import declaration
  scopeId?: string; // lexical scope identifier for local variable filtering
  isLocal?: boolean; // true if reference is to a local variable/parameter
}

/**
 * Pending reference for cross-file resolution (e.g., NgRx action group usages).
 * These are captured during parsing and resolved after indexing when global context is available.
 */
export interface PendingReference {
  container: string; // The container being accessed (e.g., 'PageActions')
  member: string; // The member being called (e.g., 'load')
  location: SymbolLocation;
  range: SymbolRange;
  containerName?: string; // Lexical scope context
}

export interface ImportInfo {
  localName: string;
  moduleSpecifier: string; // e.g., './bar', '@angular/core'
  isDefault?: boolean;
  isNamespace?: boolean; // import * as NS
  exportedName?: string; // for re-exports: export { Foo as Bar }
}

export interface ReExportInfo {
  moduleSpecifier: string; // e.g., './bar'
  isAll?: boolean; // export * from './bar'
  exportedNames?: string[]; // export { Foo, Bar } from './baz'
}

export interface IndexedFileResult {
  uri: string;
  hash: string;
  symbols: IndexedSymbol[];
  references: IndexedReference[];
  imports: ImportInfo[];
  reExports?: ReExportInfo[];
  pendingReferences?: PendingReference[]; // Cross-file references to resolve post-indexing
  shardVersion?: number; // version of the shard format
  isSkipped?: boolean; // true if file was skipped due to read error or malformed path
  skipReason?: string; // reason why file was skipped
}

export interface FileInfo {
  uri: string;
  hash: string;
  lastIndexedAt: number;
}

export interface Metadata {
  version: number;
  shardVersion?: number; // current shard format version
  lastGitHash?: string;
  lastUpdatedAt: number;
}

export const SHARD_VERSION = 2; // Bump when ID format changes

export interface IndexStats {
  totalFiles: number;
  totalSymbols: number;
  cacheHits: number;
  cacheMisses: number;
  lastUpdateTime: number;
}
