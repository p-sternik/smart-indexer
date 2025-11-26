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
}

export interface IndexedReference {
  symbolName: string; // name of the referenced symbol
  location: SymbolLocation;
  range: SymbolRange;
  containerName?: string; // context where usage occurs
  isImport?: boolean; // true if part of import declaration
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
  reExports?: ReExportInfo[]; // Track re-exports
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
