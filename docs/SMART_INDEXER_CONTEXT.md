# Smart Indexer - Architectural Context (Source of Truth)

> **Purpose:** This document serves as the authoritative architectural reference for the Smart Indexer VSCode extension. All future changes and AI-assisted development must align with this documented implementation.

**Last Updated:** 2025-11-27  
**Shard Version:** 2  
**Extension Version:** 1.3.0

---

## 1. Architecture Overview

### 1.1 Threading Model

**Implementation:** ✅ **IMPLEMENTED** - Worker Pool Architecture

- **Worker Pool Location:** `server/src/utils/workerPool.ts`
- **Worker Script:** `server/src/indexer/worker.ts`
- **Pool Size:** Dynamic - defaults to `Math.max(1, os.cpus().length - 1)`
  - Configurable via `maxConcurrentIndexJobs` (1-16 workers)
  - Typical: 3-7 workers on modern hardware

**Queue Handling:**
```typescript
interface QueuedTask {
  taskData: WorkerTaskData;
  resolve: (result: any) => void;
  reject: (error: Error) => void;
}
```

- **Strategy:** FIFO queue with automatic task dispatch
- **Load Balancing:** Greedy - tasks assigned to first idle worker
- **Error Recovery:** Automatic worker restart on crash
- **Communication Protocol:** `postMessage` with JSON serialization

**Message Format:**
```typescript
// Request (Main → Worker)
interface WorkerTaskData {
  uri: string;
  content?: string;  // Optional - worker reads from disk if absent
}

// Response (Worker → Main)
interface WorkerResult {
  success: boolean;
  result?: IndexedFileResult;
  error?: string;
}
```

**Lifecycle:**
1. `BackgroundIndex.init()` → Creates `WorkerPool` with script path
2. `WorkerPool.initializeWorkers()` → Spawns N worker threads
3. `WorkerPool.runTask()` → Queues tasks, dispatches when worker available
4. `BackgroundIndex.dispose()` → Terminates all workers

---

### 1.2 Caching Strategy

**Storage Structure:** ✅ **HASH-BASED NESTED DIRECTORY STRUCTURE**

**Location:** `.smart-index/index/<prefix1>/<prefix2>/<hash>.json`

**Example:**
```
.smart-index/
└── index/
    ├── ab/
    │   ├── 12/
    │   │   └── ab12cd34ef56...7890.json  ← Shard for file X
    │   └── cd/
    │       └── abcdef12...3456.json      ← Shard for file Y
    └── metadata.json  (not currently used - metadata in-memory only)
```

**Hash Function:**
```typescript
const hash = crypto.createHash('sha256').update(uri).digest('hex');
const prefix1 = hash.substring(0, 2);  // First 2 chars
const prefix2 = hash.substring(2, 4);  // Next 2 chars
const shardPath = `.smart-index/index/${prefix1}/${prefix2}/${hash}.json`;
```

**Shard Format (FileShard):**
```typescript
interface FileShard {
  uri: string;              // Absolute file path
  hash: string;             // SHA-256 of file content
  symbols: IndexedSymbol[]; // All symbol definitions in file
  references: IndexedReference[]; // All symbol usages in file
  imports: ImportInfo[];    // Import statements
  reExports?: ReExportInfo[]; // Re-export statements (barrel files)
  lastIndexedAt: number;    // Unix timestamp (ms)
  shardVersion?: number;    // Current: 2
  mtime?: number;           // File modification time (ms) - KEY for incremental
}
```

---

### 1.3 Incremental Indexing (Mtime-Based Cache)

**Implementation:** ✅ **IMPLEMENTED** - Mtime Check with Fallback

**Entry Point:** `BackgroundIndex.ensureUpToDate()`

**Cache Check Logic:**
```typescript
// File: server/src/index/backgroundIndex.ts (lines 454-479)
private needsReindexing(uri: string): boolean {
  const metadata = this.fileMetadata.get(uri);
  if (!metadata) {
    return true; // Cache miss
  }

  if (!metadata.mtime) {
    return true; // Legacy shard - no mtime stored
  }

  try {
    const stats = fs.statSync(uri);
    const currentMtime = stats.mtimeMs;
    
    // Fast path: mtime unchanged = file unchanged
    if (currentMtime === metadata.mtime) {
      return false; // ✅ CACHE HIT
    }
    
    return true; // Mtime changed = re-index needed
  } catch (error) {
    return true; // File missing = re-index (will error later)
  }
}
```

**Flow:**
1. **Discovery:** `ensureUpToDate()` receives all workspace files
2. **Filter Exclusions:** Apply `configManager.shouldExcludePath()`
3. **Check Mtime:** Compare `fs.stat().mtimeMs` with `shard.mtime`
4. **Skip if Unchanged:** Fast path - no indexing
5. **Queue if Changed:** Add to `filesToIndex[]`
6. **Parallel Index:** `indexFilesParallel()` with `Promise.allSettled()`

**Performance:**
- **Cache Hit:** ~0.1ms per file (stat syscall only)
- **Cache Miss:** ~5-50ms per file (full AST parse + index)

---

### 1.4 Exclusion Logic

**Implementation:** ✅ **HARDCODED + CONFIGURABLE PATTERNS**

**Enforcement Location:** `server/src/config/configurationManager.ts`

**Hardcoded Exclusions (lines 160-180):**
```typescript
const hardcodedExclusions = [
  'vscode-userdata:',
  'github.copilot-chat',
  'commandEmbeddings.json',
  '.vscode/extensions',
  'User/globalStorage',
  'User/workspaceStorage',
  // Build artifacts
  '/.angular/',    // Angular cache
  '\\.angular\\',
  '/.nx/',         // Nx cache
  '\\.nx\\',
  '/dist/',        // Distribution bundles
  '\\dist\\',
  '/coverage/',    // Test coverage
  '\\coverage\\',
  '/node_modules/',
  '\\node_modules\\',
  '/.smart-index/',
  '\\.smart-index\\'
];
```

**Configurable Patterns (via VS Code settings):**
```json
{
  "smartIndexer.excludePatterns": [
    "**/node_modules/**",
    "**/dist/**",
    "**/out/**",
    "**/.git/**",
    "**/build/**",
    "**/*.min.js",
    "**/.angular/**",
    "**/.nx/**",
    "**/coverage/**"
  ]
}
```

**Application Points:**
1. **BackgroundIndex.ensureUpToDate()** - Before adding to index queue
2. **BackgroundIndex.purgeExcludedFiles()** - Cleanup old shards
3. **FileWatcher (chokidar)** - Ignored patterns in file system watcher

---

## 2. Component Deep Dive

### 2.1 Worker: `server/src/indexer/worker.ts`

**Purpose:** Parse TypeScript/JavaScript files into symbols and references using AST traversal.

**Technology Stack:**
- **Parser:** `@typescript-eslint/typescript-estree` (not TypeScript Compiler API)
- **AST Types:** `AST_NODE_TYPES` from `@typescript-eslint/typescript-estree`
- **Execution Context:** Node.js Worker Thread

**Core Algorithm:**

```typescript
function extractCodeSymbolsAndReferences(uri: string, content: string): {
  symbols: IndexedSymbol[];
  references: IndexedReference[];
  imports: ImportInfo[];
  reExports: ReExportInfo[];
}
```

**AST Traversal Strategy:**

1. **Parse File:**
```typescript
const ast = parse(content, {
  loc: true,           // Include location info
  range: true,         // Include range info
  comment: false,      // Skip comments (performance)
  tokens: false,       // Skip tokens (performance)
  errorOnUnknownASTType: false,
  jsx: uri.endsWith('x') // Enable JSX for .tsx/.jsx
});
```

2. **Extract Imports & Re-Exports:**
   - Traverse top-level statements
   - Capture `ImportDeclaration` → `ImportInfo[]`
   - Capture `ExportNamedDeclaration` + `ExportAllDeclaration` → `ReExportInfo[]`

3. **Recursive AST Traversal:**
```typescript
function traverseAST(
  node: TSESTree.Node,
  symbols: IndexedSymbol[],
  references: IndexedReference[],
  uri: string,
  containerName?: string,
  containerKind?: string,
  containerPath: string[] = [],
  imports: ImportInfo[] = [],
  scopeTracker?: ScopeTracker,
  parent: TSESTree.Node | null = null  // NEW: Parent tracking
): void
```

**Symbol Extraction (Declarations):**
```typescript
switch (node.type) {
  case AST_NODE_TYPES.FunctionDeclaration:
    symbolKind = 'function';
    parametersCount = node.params.length;
    break;
  case AST_NODE_TYPES.ClassDeclaration:
    symbolKind = 'class';
    break;
  case AST_NODE_TYPES.MethodDefinition:
    symbolKind = 'method';
    isStatic = node.static;
    parametersCount = node.value.params.length;
    break;
  case AST_NODE_TYPES.PropertyDefinition:
    symbolKind = 'property';
    isStatic = node.static;
    break;
  case AST_NODE_TYPES.VariableDeclaration:
    symbolKind = node.kind === 'const' ? 'constant' : 'variable';
    break;
  case AST_NODE_TYPES.TSInterfaceDeclaration:
    symbolKind = 'interface';
    break;
  case AST_NODE_TYPES.TSTypeAliasDeclaration:
    symbolKind = 'type';
    break;
  case AST_NODE_TYPES.TSEnumDeclaration:
    symbolKind = 'enum';
    break;
}
```

**Reference Extraction (Usages) - RECENT IMPROVEMENT:**

**Before (Naive):**
```typescript
if (node.type === AST_NODE_TYPES.Identifier) {
  // ❌ Always added to references (even declarations!)
  references.push({ symbolName: node.name, ... });
}
```

**After (Context-Aware):**
```typescript
// NEW: Check if identifier is a declaration
function isDeclarationContext(node: TSESTree.Node, parent: TSESTree.Node | null): boolean {
  if (!parent) return false;
  
  switch (parent.type) {
    case AST_NODE_TYPES.FunctionDeclaration:
      return parent.id === node;  // Function name
    case AST_NODE_TYPES.MethodDefinition:
      return parent.key === node; // Method name ✅ EXCLUDES from references
    case AST_NODE_TYPES.PropertyDefinition:
      return parent.key === node; // Property name ✅ EXCLUDES from references
    case AST_NODE_TYPES.VariableDeclarator:
      return parent.id === node;  // Variable name
    // ... (see AST_PARSER_IMPROVEMENTS.md for full list)
  }
}

// Usage:
if (node.type === AST_NODE_TYPES.Identifier && !isDeclarationContext(node, parent)) {
  references.push({ symbolName: node.name, ... }); // ✅ Only true usages
}
```

**Special Handling:**

- **MemberExpression:** `obj.prop.method()`
  - Always captured as reference to `prop` and `method`
  - Never a declaration

- **Object Literal Properties:**
  - `{ createAction: () => ({...}) }` → Symbol with kind 'property'
  - Nested objects recursively indexed

- **Scope Tracking:**
  - `ScopeTracker` maintains lexical scope stack
  - Marks local variables to differentiate from imports

**Symbol ID Generation:**
```typescript
createSymbolId(
  uri,              // File path
  name,             // Symbol name
  containerName,    // Parent class/namespace
  fullContainerPath, // e.g., "ng.forms.CompatFieldAdapter"
  kind,             // 'function', 'class', 'method', etc.
  isStatic,         // For class members
  parametersCount,  // For overload disambiguation
  line,             // Location (for uniqueness)
  character
)
// Returns: hash-based stable ID (survives file edits)
```

---

### 2.2 BackgroundIndex: `server/src/index/backgroundIndex.ts`

**Purpose:** Persistent, sharded, incremental index inspired by Clangd's background index.

**Lifecycle:**

```
┌─────────────────────────────────────────────────────────────┐
│ 1. STARTUP: init(workspaceRoot, cacheDirectory)            │
│    - Create .smart-index/index/ directory                   │
│    - Initialize WorkerPool with N workers                   │
│    - Load shard metadata into memory (lightweight)          │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 2. DISCOVERY: ensureUpToDate(allFiles)                     │
│    - Scan workspace (FileScanner)                           │
│    - Filter exclusions (ConfigurationManager)               │
│    - Check mtime for each file (needsReindexing)            │
│    - Build list of files needing indexing                   │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 3. WORKER DISPATCH: indexFilesParallel(filesToIndex)       │
│    - Submit all files to WorkerPool (Promise.allSettled)    │
│    - Workers process files in parallel                      │
│    - Each worker:                                            │
│      1. Read file from disk                                  │
│      2. Parse AST (typescript-estree)                        │
│      3. Extract symbols & references                         │
│      4. Return IndexedFileResult                             │
└─────────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────────┐
│ 4. CACHE MERGE: updateFile(uri, result)                    │
│    - Remove old entries from in-memory indexes              │
│    - Add new symbols to symbolNameIndex (name → URIs)       │
│    - Add new symbols to symbolIdIndex (id → URI)            │
│    - Add new references to referenceMap (name → URIs)       │
│    - Save shard to disk (nested hash structure)             │
│    - Update fileMetadata with hash + mtime                   │
└─────────────────────────────────────────────────────────────┘
```

**In-Memory Indexes:**

```typescript
class BackgroundIndex {
  // Lightweight metadata (NEVER loads full shards into memory)
  private fileMetadata: Map<string, {
    hash: string;
    lastIndexedAt: number;
    symbolCount: number;
    mtime?: number;
  }> = new Map();

  // Inverted index: symbol name → Set of file URIs containing that symbol
  private symbolNameIndex: Map<string, Set<string>> = new Map();

  // Direct lookup: symbol ID → file URI
  private symbolIdIndex: Map<string, string> = new Map();

  // Inverted index: symbol name → Set of file URIs containing references
  private referenceMap: Map<string, Set<string>> = new Map();
}
```

**Query Flow (Lazy Loading):**

```typescript
async findDefinitions(name: string): Promise<IndexedSymbol[]> {
  // 1. Consult inverted index (in-memory)
  const uriSet = this.symbolNameIndex.get(name);
  if (!uriSet) return [];

  // 2. Lazy-load shards only for relevant files
  const results: IndexedSymbol[] = [];
  for (const uri of uriSet) {
    const shard = await this.loadShard(uri); // Read from disk
    if (shard) {
      results.push(...shard.symbols.filter(s => s.name === name));
    }
  }
  return results;
}
```

**Live Sync Integration:**
```typescript
async updateSingleFile(filePath: string): Promise<void> {
  // STEP A: Cleanup - remove old entries
  this.cleanupFileFromIndexes(filePath);

  // STEP B: Process - re-index file (via WorkerPool)
  const result = await this.workerPool.runTask({ uri: filePath });

  // STEP C & D: Merge and Persist
  await this.updateFile(filePath, result);
}
```

---

### 2.3 FileWatcher: `server/src/index/fileWatcher.ts`

**Purpose:** Live synchronization with per-file debouncing to prevent re-indexing on every keystroke.

**Implementation:** ✅ **IMPLEMENTED** - Dual Listener (LSP + Chokidar)

**Listeners:**

1. **LSP Text Document Changes:**
```typescript
this.documents.onDidChangeContent(this.onDocumentChanged.bind(this));
this.documents.onDidSave(this.onDocumentSaved.bind(this));
```

2. **External File System Changes (Chokidar):**
```typescript
this.fsWatcher = chokidar.watch(this.workspaceRoot, {
  ignored: [
    '**/node_modules/**',
    '**/.git/**',
    '**/dist/**',
    '**/.smart-index/**',
    ...config.excludePatterns
  ],
  awaitWriteFinish: {
    stabilityThreshold: 300,  // Wait 300ms after last write
    pollInterval: 100
  }
});

this.fsWatcher.on('change', (filePath: string) => {
  this.scheduleReindex(filePath); // Debounced
});
```

**Debouncing Strategy:**

```typescript
// Per-file debounce map
private debounceMap: Map<string, NodeJS.Timeout> = new Map();
private debounceDelayMs: number = 600; // Default: 600ms

private scheduleReindex(filePath: string): void {
  // Cancel previous timer for this file
  const existingTimer = this.debounceMap.get(filePath);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Schedule new index after delay
  const timer = setTimeout(() => {
    this.reindexFile(filePath);
    this.debounceMap.delete(filePath);
  }, this.debounceDelayMs);

  this.debounceMap.set(filePath, timer);
}
```

**Deduplication:**
```typescript
// Track files currently being indexed
private indexingInProgress: Set<string> = new Set();

private async reindexFile(filePath: string): Promise<void> {
  if (this.indexingInProgress.has(filePath)) {
    return; // Skip duplicate request
  }

  this.indexingInProgress.add(filePath);
  try {
    await this.backgroundIndex.updateSingleFile(filePath);
  } finally {
    this.indexingInProgress.delete(filePath);
  }
}
```

---

### 2.4 Extension Client: `src/extension.ts`

**Purpose:** VS Code extension host - manages Language Client and hybrid providers.

**Modes:**

1. **Standalone Mode:**
   - Smart Indexer exclusively handles `textDocument/definition` and `textDocument/references`
   - Faster but may miss TypeScript-specific nuances

2. **Hybrid Mode (DEFAULT):** ✅ **IMPLEMENTED**
   - Merges results from both Smart Indexer and native TypeScript service
   - Deduplicates overlapping results
   - Best accuracy with good performance

**Hybrid Provider Architecture:**

```typescript
// Wrapper around LSP client
const smartDefinitionProvider = async (
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken
): Promise<vscode.Definition | vscode.LocationLink[] | null> => {
  return await client.sendRequest('textDocument/definition', {
    textDocument: { uri: document.uri.toString() },
    position: { line: position.line, character: position.character }
  }, token);
};

// Hybrid provider with deduplication
const hybridDefinitionProvider = new HybridDefinitionProvider(
  smartDefinitionProvider,
  hybridTimeout,  // Default: 100ms
  logChannel
);

// Register with VS Code
context.subscriptions.push(
  vscode.languages.registerDefinitionProvider(
    languageSelector,
    hybridDefinitionProvider
  )
);
```

---

### 2.5 Hybrid Providers: `src/providers/`

**HybridDefinitionProvider:**

```typescript
async provideDefinition(
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken
): Promise<vscode.Definition | vscode.LocationLink[] | null> {
  // Fetch both in parallel
  const [nativeResult, smartResult] = await Promise.all([
    this.fetchNativeDefinitions(document, position, token),
    this.smartIndexerProvider(document, position, token)
  ]);

  // Merge and deduplicate
  return this.mergeAndDeduplicate(nativeResult, smartResult);
}
```

**Deduplication Logic:**

```typescript
private mergeAndDeduplicate(
  nativeLocations: vscode.Location[],
  smartLocations: vscode.Location[]
): vscode.Location[] {
  const locationMap = new Map<string, vscode.Location>();

  // 1. Add native results (prefer for accuracy)
  for (const loc of nativeLocations) {
    const key = this.getLocationKey(loc);
    locationMap.set(key, loc);
  }

  // 2. Add smart results, checking for near-duplicates
  for (const loc of smartLocations) {
    const key = this.getLocationKey(loc);
    if (locationMap.has(key)) continue; // Exact duplicate

    // Check within 2 lines (near-duplicate detection)
    let isDuplicate = false;
    for (const existingLoc of locationMap.values()) {
      if (this.areLocationsSimilar(loc, existingLoc)) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) {
      locationMap.set(key, loc);
    }
  }

  return Array.from(locationMap.values());
}

private areLocationsSimilar(
  loc1: vscode.Location,
  loc2: vscode.Location
): boolean {
  return (
    loc1.uri.fsPath === loc2.uri.fsPath &&
    Math.abs(loc1.range.start.line - loc2.range.start.line) <= 2
  );
}
```

**HybridReferencesProvider:**
- Same architecture as `HybridDefinitionProvider`
- Handles `textDocument/references` LSP request
- Deduplicates reference locations

---

### 2.6 TypeScript Service: `server/src/typescript/typeScriptService.ts`

**Purpose:** Fallback to TypeScript Language Service for ambiguous cases.

**When Used:**
- Overloaded methods (same name, different signatures)
- Generic type resolution
- Complex property chains

**Not Used For:**
- Primary indexing (too slow for 10k+ files)
- Initial workspace scan
- Live file watching

---

## 3. Data Structures

### 3.1 IndexedSymbol (Definition)

```typescript
export interface IndexedSymbol {
  id: string;              // Stable symbol identifier (hash-based)
  name: string;            // Symbol name (e.g., "createAction")
  kind: string;            // 'function' | 'class' | 'method' | 'property' | 
                           // 'interface' | 'type' | 'enum' | 'variable' | 'constant'
  location: SymbolLocation; // Where defined
  range: SymbolRange;      // Full range of definition
  containerName?: string;  // Parent class/namespace (e.g., "MyClass")
  containerKind?: string;  // Parent kind (e.g., "class")
  fullContainerPath?: string; // Full path (e.g., "ng.forms.CompatFieldAdapter")
  filePath: string;        // Absolute file path
  isStatic?: boolean;      // For class members
  parametersCount?: number; // For functions/methods (overload disambiguation)
  ngrxMetadata?: NgRxMetadata; // NgRx-specific information (see section 3.6)
}

export interface NgRxMetadata {
  type: string;            // Action type string or effect name
  role: 'action' | 'effect' | 'reducer'; // NgRx role
}
```

### 3.2 IndexedReference (Usage)

```typescript
export interface IndexedReference {
  symbolName: string;      // Name of referenced symbol
  location: SymbolLocation; // Where used
  range: SymbolRange;      // Range of usage
  containerName?: string;  // Context where usage occurs
  isImport?: boolean;      // true if part of import statement
  scopeId?: string;        // Lexical scope identifier (e.g., "MyClass::myMethod")
  isLocal?: boolean;       // true if reference to local variable/parameter
}
```

### 3.3 Reference Map (Inverted Index)

```typescript
// In-memory structure in BackgroundIndex
private referenceMap: Map<string, Set<string>> = new Map();

// Example:
referenceMap.get('createSigningStepStart') → Set([
  '/path/to/facade.ts',      // Contains: this.store.dispatch(Actions.createSigningStepStart())
  '/path/to/effects.ts',     // Contains: ofType(Actions.createSigningStepStart)
  '/path/to/reducer.ts'      // Contains: case Actions.createSigningStepStart.type
])

// Fast path: Query only relevant shards
async findReferencesByName(name: string): Promise<IndexedReference[]> {
  const candidateUris = this.referenceMap.get(name); // O(1)
  if (!candidateUris) return [];

  const references: IndexedReference[] = [];
  for (const uri of candidateUris) {
    const shard = await this.loadShard(uri); // Lazy load
    references.push(...shard.references.filter(r => r.symbolName === name));
  }
  return references;
}
```

### 3.4 Worker Message Protocol

**Request (Main Thread → Worker):**
```typescript
interface WorkerTaskData {
  uri: string;        // Absolute file path
  content?: string;   // Optional: file content (if already in memory)
}

// Example:
worker.postMessage({
  uri: '/workspace/src/app/facade.ts'
  // Worker will read from disk if content omitted
});
```

**Response (Worker → Main Thread):**
```typescript
interface WorkerResult {
  success: boolean;
  result?: IndexedFileResult;
  error?: string;
}

interface IndexedFileResult {
  uri: string;
  hash: string;
  symbols: IndexedSymbol[];
  references: IndexedReference[];
  imports: ImportInfo[];
  reExports?: ReExportInfo[];
  shardVersion?: number;
}

// Example:
{
  success: true,
  result: {
    uri: '/workspace/src/app/facade.ts',
    hash: 'a3f2b1...',
    symbols: [
      { id: 'sym_123', name: 'SigningFacade', kind: 'class', ... },
      { id: 'sym_124', name: 'createSigningStepStart', kind: 'method', ... }
    ],
    references: [
      { symbolName: 'createSigningStepStart', location: {...}, ... }
    ],
    imports: [
      { localName: 'Store', moduleSpecifier: '@ngrx/store', isDefault: false }
    ],
    shardVersion: 2
  }
}
```

### 3.5 Shard JSON Format (Disk)

```json
{
  "uri": "/workspace/src/app/facade.ts",
  "hash": "a3f2b1c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t1u2v3w4x5y6z7",
  "symbols": [
    {
      "id": "sym_a1b2c3d4e5f6",
      "name": "SigningFacade",
      "kind": "class",
      "location": { "uri": "/workspace/src/app/facade.ts", "line": 10, "character": 13 },
      "range": { "startLine": 10, "startCharacter": 0, "endLine": 50, "endCharacter": 1 },
      "filePath": "/workspace/src/app/facade.ts"
    },
    {
      "id": "sym_b2c3d4e5f6g7",
      "name": "createSigningStepStart",
      "kind": "method",
      "location": { "uri": "/workspace/src/app/facade.ts", "line": 20, "character": 9 },
      "range": { "startLine": 20, "startCharacter": 2, "endLine": 23, "endCharacter": 3 },
      "containerName": "SigningFacade",
      "containerKind": "class",
      "fullContainerPath": "SigningFacade",
      "filePath": "/workspace/src/app/facade.ts",
      "isStatic": false,
      "parametersCount": 0
    }
  ],
  "references": [
    {
      "symbolName": "createSigningStepStart",
      "location": { "uri": "/workspace/src/app/facade.ts", "line": 22, "character": 45 },
      "range": { "startLine": 22, "startCharacter": 45, "endLine": 22, "endCharacter": 68 },
      "containerName": "createSigningStepStart",
      "scopeId": "SigningFacade::createSigningStepStart",
      "isLocal": false
    }
  ],
  "imports": [
    {
      "localName": "Store",
      "moduleSpecifier": "@ngrx/store",
      "isDefault": false
    }
  ],
  "reExports": [],
  "lastIndexedAt": 1701234567890,
  "shardVersion": 2,
  "mtime": 1701234567000
}
```

---

### 3.6 NgRx Pattern Recognition

**Status:** ✅ **IMPLEMENTED** (2025-11-27)

**Purpose:** Specialized detection and linking of Angular/NgRx Actions, Effects, and Reducers.

#### Modern NgRx Actions

```typescript
// Source code
export const loadProducts = createAction('[Products] Load');

// Indexed as
{
  id: 'sym_abc123',
  name: 'loadProducts',
  kind: 'constant',
  ngrxMetadata: {
    type: '[Products] Load',
    role: 'action'
  }
}
```

**Detection Logic (worker.ts:455-477):**
```typescript
if (decl.init && decl.init.type === CallExpression) {
  if (isNgRxCreateActionCall(decl.init)) {
    const actionType = extractActionTypeString(decl.init);
    ngrxMetadata = { type: actionType, role: 'action' };
  }
}
```

#### Modern NgRx Effects

```typescript
// Source code
export class ProductsEffects {
  loadProducts$ = createEffect(() => this.actions$.pipe(
    ofType(loadProducts)  // ← Reference detection
  ));
}

// Property indexed as
{
  id: 'sym_def456',
  name: 'loadProducts$',
  kind: 'property',
  ngrxMetadata: {
    type: 'loadProducts$',
    role: 'effect'
  }
}
```

**Detection Logic (worker.ts:606-627):**
```typescript
if (propNode.value && isNgRxCreateEffectCall(propNode.value)) {
  ngrxMetadata = { type: propName, role: 'effect' };
}
```

#### NgRx Reference Detection

**ofType() in Effects:**
```typescript
ofType(loadProducts)  // ← Creates reference to 'loadProducts' symbol
ofType(Actions.load)  // ← Creates reference to 'load' property
```

**on() in Reducers:**
```typescript
on(loadProducts, state => ({ ...state, loading: true }))
// ↑ Creates reference to 'loadProducts' symbol
```

#### Legacy NgRx Support

**Action Classes:**
```typescript
export class LoadUsers implements Action {
  readonly type = UserActionTypes.Load;
}
// Indexed with ngrxMetadata: { type: 'Load', role: 'action' }
```

**@Effect Decorator:**
```typescript
@Effect()
loadUsers$ = this.actions$.pipe(ofType('[Users] Load'));
// Indexed with ngrxMetadata: { type: 'loadUsers$', role: 'effect' }
```

**Documentation:** See `NGRX_PATTERN_RECOGNITION.md` for full implementation guide.

---

## 4. Current Features Status

### ✅ IMPLEMENTED Features

| Feature | Status | Location | Notes |
|---------|--------|----------|-------|
| **Worker Pool** | ✅ IMPLEMENTED | `server/src/utils/workerPool.ts` | Dynamic pool size, FIFO queue, auto-restart |
| **Incremental Indexing** | ✅ IMPLEMENTED | `server/src/index/backgroundIndex.ts` | Mtime-based cache, fast path for unchanged files |
| **Live Sync** | ✅ IMPLEMENTED | `server/src/index/fileWatcher.ts` | Dual listener (LSP + chokidar), 600ms debounce |
| **Deduplication** | ✅ IMPLEMENTED | `src/providers/HybridDefinitionProvider.ts` | Near-duplicate detection (±2 lines) |
| **Sharded Storage** | ✅ IMPLEMENTED | `server/src/index/backgroundIndex.ts` | Hash-based nested dirs, lazy loading |
| **Scope Tracking** | ✅ IMPLEMENTED | `server/src/indexer/worker.ts` | `ScopeTracker` for local variable filtering |
| **Declaration vs Usage** | ✅ IMPLEMENTED | `server/src/indexer/worker.ts` | `isDeclarationContext()` - excludes declarations from references |
| **Import Resolution** | ✅ IMPLEMENTED | `server/src/indexer/importResolver.ts` | Resolves relative/absolute imports |
| **Re-Export Resolution** | ✅ IMPLEMENTED | `server/src/server.ts` | Depth-limited barrel file traversal |
| **Hybrid Mode** | ✅ IMPLEMENTED | `src/extension.ts` | Merges native TS + Smart Indexer results |
| **NgRx Pattern Recognition** | ✅ IMPLEMENTED | `server/src/indexer/worker.ts` | Detects Actions, Effects, Reducers (modern & legacy) |

---

### ⚠️ PARTIAL Features

| Feature | Status | Notes |
|---------|--------|-------|
| **TypeScript Fallback** | ⚠️ PARTIAL | `server/src/typescript/typeScriptService.ts` - Exists but underutilized |
| **Dead Code Detection** | ⚠️ PARTIAL | `server/src/features/deadCode.ts` - Experimental beta feature |
| **Static Index** | ⚠️ PARTIAL | `server/src/index/staticIndex.ts` - Optional, rarely used |

---

### ❌ NOT IMPLEMENTED / MISSING Features

| Feature | Status | Notes |
|---------|--------|-------|
| **NgRx Type String Indexing** | ❌ MISSING | Type strings like `'[Products] Load'` not indexed as virtual symbols |
| **Type-Aware Resolution** | ❌ MISSING | No generic type parameter tracking |
| **Cross-File Type Inference** | ❌ MISSING | No type flow analysis |
| **Monorepo Support** | ❌ MISSING | No multi-root workspace handling |
| **Symbol Renaming** | ❌ MISSING | No `textDocument/rename` implementation |

---

## 5. Key Patterns & Anti-Patterns

### ✅ DO

- **Use mtime checks for cache validation** - Fastest incremental indexing
- **Load shards lazily** - Never keep all shards in memory
- **Pass parent node in AST traversal** - Required for declaration detection
- **Apply exclusions early** - Before adding to index queue
- **Use inverted indexes** - `referenceMap` for fast reference lookups
- **Debounce file changes** - 600ms default to avoid re-indexing on every keystroke
- **Use WorkerPool for parallelism** - Essential for large codebases

### ❌ DON'T

- **Don't index build artifacts** - `.angular/`, `dist/`, `node_modules/`
- **Don't use TypeScript Compiler API in workers** - Too heavy, use `typescript-estree`
- **Don't assume parent context without passing it** - Old bug (now fixed)
- **Don't skip mtime storage** - Breaks incremental indexing
- **Don't load all shards on startup** - Memory explosion for large projects
- **Don't add declarations to references** - Use `isDeclarationContext()`

---

## 6. Performance Characteristics

| Operation | Time | Notes |
|-----------|------|-------|
| **Initial Index (10k files)** | ~20-60s | Parallel with 4 workers |
| **Incremental Update (1 file)** | ~5-50ms | AST parse + update shard |
| **Cache Hit (unchanged file)** | ~0.1ms | Stat syscall only |
| **Find Definitions (common symbol)** | ~5-20ms | Inverted index + lazy load 3-10 shards |
| **Find References (rare symbol)** | ~2-5ms | Inverted index + lazy load 1-2 shards |
| **Workspace Symbol Search** | ~50-200ms | Fuzzy match + lazy load top N shards |

---

## 7. Configuration Reference

**File:** `package.json` → `contributes.configuration.properties`

```json
{
  "smartIndexer.mode": {
    "type": "string",
    "enum": ["standalone", "hybrid"],
    "default": "hybrid",
    "description": "Standalone uses only Smart Indexer. Hybrid merges with native TS service."
  },
  "smartIndexer.hybridTimeoutMs": {
    "type": "number",
    "default": 100,
    "description": "Timeout for native TypeScript service in hybrid mode (ms)"
  },
  "smartIndexer.cacheDirectory": {
    "type": "string",
    "default": ".smart-index",
    "description": "Directory for persistent cache (relative to workspace root)"
  },
  "smartIndexer.maxConcurrentIndexJobs": {
    "type": "number",
    "default": 4,
    "minimum": 1,
    "maximum": 16,
    "description": "Number of worker threads for parallel indexing"
  },
  "smartIndexer.excludePatterns": {
    "type": "array",
    "default": [
      "**/node_modules/**",
      "**/dist/**",
      "**/.angular/**",
      "**/.nx/**",
      "**/coverage/**"
    ],
    "description": "Glob patterns to exclude from indexing"
  }
}
```

---

## 8. Future Enhancement Opportunities

### High Priority
1. **NgRx Virtual Symbol Indexing** ⚠️ **NEXT PHASE**
   - Index type strings as virtual symbols
   - Link `case '[Products] Load':` to action creator
   - Enable cross-file type string navigation

2. **Monorepo Support**
   - Multi-root workspace handling
   - Cross-package symbol resolution
   - Shared cache optimization

3. **Type-Aware Filtering**
   - Generic type parameter tracking
   - Method overload disambiguation via type inference
   - Interface implementation detection

### Medium Priority
4. **Symbol Renaming**
   - Implement `textDocument/rename` LSP handler
   - Update all references atomically
   - Handle re-exports correctly

5. **Performance Optimization**
   - Parallel shard loading (currently sequential)
   - Binary shard format (faster than JSON)
   - Incremental AST parsing (only changed ranges)

### Low Priority
6. **Enhanced Dead Code Detection**
   - Analyze unused exports
   - Detect orphaned files
   - Entry point analysis

---

## 9. Troubleshooting Guide

### Issue: "Index not updating after file changes"
**Diagnosis:**
- Check FileWatcher is initialized: `server/src/server.ts` → `fileWatcher.init()`
- Verify file not excluded: `configManager.shouldExcludePath()`
- Check debounce delay: Default 600ms

**Fix:**
- Ensure chokidar watcher is running (check logs for `[FileWatcher] Initialized`)
- Verify file extensions match: `.ts`, `.tsx`, `.js`, `.jsx`

---

### Issue: "Duplicate definitions/references"
**Diagnosis:**
- Check if hybrid mode is enabled
- Verify deduplication logic in `HybridDefinitionProvider`

**Fix:**
- Ensure `areLocationsSimilar()` threshold is ±2 lines
- Check for exact key duplicates first

---

### Issue: "Method declarations appear in Find References"
**Diagnosis:**
- Old bug - fixed in recent update
- Check `isDeclarationContext()` implementation

**Fix:**
- Ensure `parent` parameter is passed in `traverseAST()`
- Verify `MethodDefinition` case returns `parent.key === node`

---

## 10. Changelog

**Recent Changes (2025-11-27):**

- ✅ **NgRx Pattern Recognition** - Specialized detection for Angular/NgRx patterns
  - Detects modern `createAction()` and extracts action type strings
  - Detects modern `createEffect()` in class properties
  - Detects legacy Action classes with `implements Action`
  - Detects legacy `@Effect()` decorators
  - Links `ofType()` and `on()` references to action creators
  - Added `NgRxMetadata` interface with role and type information
  - See: `NGRX_PATTERN_RECOGNITION.md`, `NGRX_QUICK_REF.md`, `test-files/ngrx-patterns-test.ts`

- ✅ **Declaration vs Usage Detection** - Fixed false positives in reference search
  - Added `isDeclarationContext()` to properly identify declarations
  - Updated `traverseAST()` to pass parent node
  - Method/property declarations now excluded from references
  - See: `AST_PARSER_IMPROVEMENTS.md`, `AST_PARSER_QUICK_REF.md`, `AST_PARSER_CODE_CHANGES.md`

**Previous Changes:**
- See `CHANGELOG.md` for full history

---

## 11. Related Documentation

- **Implementation Details:** `IMPLEMENTATION_COMPLETE.md`
- **Incremental Indexing:** `INCREMENTAL_INDEXING_IMPLEMENTATION.md`
- **Live Sync:** `LIVE_SYNC_IMPLEMENTATION.md`
- **Worker Pool:** `WORKER_POOL_ARCHITECTURE.md`
- **Storage Optimization:** `STORAGE_IMPLEMENTATION_SUMMARY.md`
- **AST Parser Improvements:** `AST_PARSER_IMPROVEMENTS.md`
- **Hybrid Deduplication:** `HYBRID_DEDUPLICATION_IMPLEMENTATION.md`
- **NgRx Pattern Recognition:** `NGRX_PATTERN_RECOGNITION.md` ✨ **NEW**
- **NgRx Quick Reference:** `NGRX_QUICK_REF.md` ✨ **NEW**

---

**END OF ARCHITECTURAL CONTEXT**
