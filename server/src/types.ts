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

/**
 * Compact position for storage - no uri (inferred from shard)
 */
export interface CompactPosition {
  l: number;  // line
  c: number;  // character
}

/**
 * Compact range for storage - shorter field names
 */
export interface CompactRange {
  sl: number;  // startLine
  sc: number;  // startCharacter
  el: number;  // endLine
  ec: number;  // endCharacter
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
  /** @deprecated Use metadata.ngrx instead. Kept for backwards compatibility. */
  ngrxMetadata?: NgRxMetadata; // NgRx-specific information
  /** Generic metadata for framework plugins (Angular, NgRx, React, etc.) */
  metadata?: Record<string, unknown>;
  /** Flag to distinguish definitions (true) from usages/references (false). Used for precise "Go to Definition" filtering. */
  isDefinition?: boolean;
}

/**
 * Compact symbol for storage - no redundant uri/filePath fields
 * These are inferred from the shard's uri when hydrated
 */
export interface CompactSymbol {
  id: string;
  n: string;   // name
  k: string;   // kind
  p: CompactPosition;  // position (line, char)
  r: CompactRange;     // range
  cn?: string; // containerName
  ck?: string; // containerKind
  cp?: string; // fullContainerPath
  s?: boolean; // isStatic
  pc?: number; // parametersCount
  nx?: NgRxMetadata; // ngrxMetadata (deprecated, for backwards compat)
  md?: Record<string, unknown>; // metadata (generic plugin metadata)
  d?: boolean; // isDefinition (true for definitions, false/undefined for references)
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
 * Compact reference for storage - no redundant uri field
 * Scope IDs use numeric index into shard's scope table
 */
export interface CompactReference {
  sn: string;  // symbolName
  p: CompactPosition;  // position
  r: CompactRange;     // range
  cn?: string; // containerName
  im?: boolean; // isImport
  si?: number;  // scopeIndex (into shard's scope table)
  lo?: boolean; // isLocal
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

/**
 * Compact pending reference for storage
 */
export interface CompactPendingReference {
  ct: string;  // container
  mb: string;  // member
  p: CompactPosition;
  r: CompactRange;
  cn?: string; // containerName
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

// Bump when storage format changes - forces re-indexing
export const SHARD_VERSION = 4;

/**
 * Compact shard format for storage - significantly smaller than full format
 * Eliminates redundant uri fields (stored once in header)
 * Uses short field names and numeric scope indices
 */
export interface CompactShard {
  u: string;   // uri
  h: string;   // hash
  s: CompactSymbol[];      // symbols
  r: CompactReference[];   // references
  i: ImportInfo[];         // imports (already compact)
  re?: ReExportInfo[];     // reExports
  pr?: CompactPendingReference[]; // pendingReferences
  sc?: string[];           // scope table (for reference scopeIndex)
  t: number;   // lastIndexedAt
  v: number;   // shardVersion
  m?: number;  // mtime
}

/**
 * Convert full IndexedSymbol to compact storage format
 */
export function compactSymbol(sym: IndexedSymbol): CompactSymbol {
  const compact: CompactSymbol = {
    id: sym.id,
    n: sym.name,
    k: sym.kind,
    p: { l: sym.location.line, c: sym.location.character },
    r: {
      sl: sym.range.startLine,
      sc: sym.range.startCharacter,
      el: sym.range.endLine,
      ec: sym.range.endCharacter
    }
  };
  if (sym.containerName) { compact.cn = sym.containerName; }
  if (sym.containerKind) { compact.ck = sym.containerKind; }
  if (sym.fullContainerPath) { compact.cp = sym.fullContainerPath; }
  if (sym.isStatic) { compact.s = sym.isStatic; }
  if (sym.parametersCount !== undefined) { compact.pc = sym.parametersCount; }
  if (sym.ngrxMetadata) { compact.nx = sym.ngrxMetadata; }
  if (sym.metadata && Object.keys(sym.metadata).length > 0) { compact.md = sym.metadata; }
  if (sym.isDefinition !== undefined) { compact.d = sym.isDefinition; }
  return compact;
}

/**
 * Hydrate compact symbol to full IndexedSymbol
 */
export function hydrateSymbol(compact: CompactSymbol, uri: string): IndexedSymbol {
  return {
    id: compact.id,
    name: compact.n,
    kind: compact.k,
    location: { uri, line: compact.p.l, character: compact.p.c },
    range: {
      startLine: compact.r.sl,
      startCharacter: compact.r.sc,
      endLine: compact.r.el,
      endCharacter: compact.r.ec
    },
    containerName: compact.cn,
    containerKind: compact.ck,
    fullContainerPath: compact.cp,
    filePath: uri,
    isStatic: compact.s,
    parametersCount: compact.pc,
    ngrxMetadata: compact.nx,
    metadata: compact.md,
    isDefinition: compact.d
  };
}

/**
 * Convert full IndexedReference to compact storage format
 */
export function compactReference(ref: IndexedReference, scopeTable: Map<string, number>): CompactReference {
  const compact: CompactReference = {
    sn: ref.symbolName,
    p: { l: ref.location.line, c: ref.location.character },
    r: {
      sl: ref.range.startLine,
      sc: ref.range.startCharacter,
      el: ref.range.endLine,
      ec: ref.range.endCharacter
    }
  };
  if (ref.containerName) { compact.cn = ref.containerName; }
  if (ref.isImport) { compact.im = ref.isImport; }
  if (ref.scopeId) {
    // Use numeric index into scope table
    let idx = scopeTable.get(ref.scopeId);
    if (idx === undefined) {
      idx = scopeTable.size;
      scopeTable.set(ref.scopeId, idx);
    }
    compact.si = idx;
  }
  if (ref.isLocal) { compact.lo = ref.isLocal; }
  return compact;
}

/**
 * Hydrate compact reference to full IndexedReference
 */
export function hydrateReference(compact: CompactReference, uri: string, scopeTable: string[]): IndexedReference {
  return {
    symbolName: compact.sn,
    location: { uri, line: compact.p.l, character: compact.p.c },
    range: {
      startLine: compact.r.sl,
      startCharacter: compact.r.sc,
      endLine: compact.r.el,
      endCharacter: compact.r.ec
    },
    containerName: compact.cn,
    isImport: compact.im,
    scopeId: compact.si !== undefined ? scopeTable[compact.si] : undefined,
    isLocal: compact.lo
  };
}

/**
 * Convert full PendingReference to compact storage format
 */
export function compactPendingRef(ref: PendingReference): CompactPendingReference {
  const compact: CompactPendingReference = {
    ct: ref.container,
    mb: ref.member,
    p: { l: ref.location.line, c: ref.location.character },
    r: {
      sl: ref.range.startLine,
      sc: ref.range.startCharacter,
      el: ref.range.endLine,
      ec: ref.range.endCharacter
    }
  };
  if (ref.containerName) { compact.cn = ref.containerName; }
  return compact;
}

/**
 * Hydrate compact pending reference to full PendingReference
 */
export function hydratePendingRef(compact: CompactPendingReference, uri: string): PendingReference {
  return {
    container: compact.ct,
    member: compact.mb,
    location: { uri, line: compact.p.l, character: compact.p.c },
    range: {
      startLine: compact.r.sl,
      startCharacter: compact.r.sc,
      endLine: compact.r.el,
      endCharacter: compact.r.ec
    },
    containerName: compact.cn
  };
}

export interface IndexStats {
  totalFiles: number;
  totalSymbols: number;
  cacheHits: number;
  cacheMisses: number;
  lastUpdateTime: number;
}
