import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

/**
 * TypeScriptService - Manages TypeScript LanguageService for precise symbol resolution.
 * This is used as a fallback when index-based resolution is ambiguous.
 * 
 * Optimizations:
 * - Uses persistent ts.LanguageService (not recreated on each request)
 * - Incremental updates via IScriptSnapshot registry
 * - Keeps program "warm" for instant getSymbolAtLocation calls
 */
export class TypeScriptService {
  private languageService: ts.LanguageService | null = null;
  private documentRegistry: ts.DocumentRegistry;
  private files: Map<string, { version: number; snapshot: ts.IScriptSnapshot }> = new Map();
  private compilerOptions: ts.CompilerOptions;
  private workspaceRoot: string = '';
  private serviceHost: ts.LanguageServiceHost | null = null;

  constructor() {
    this.documentRegistry = ts.createDocumentRegistry();
    this.compilerOptions = this.getDefaultCompilerOptions();
  }

  /**
   * Initialize the TypeScript service with workspace root and optional tsconfig.
   */
  async init(workspaceRoot: string): Promise<void> {
    this.workspaceRoot = workspaceRoot;
    
    // Try to load tsconfig.json
    const tsconfigPath = path.join(workspaceRoot, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      try {
        const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
        if (configFile.config) {
          const parsed = ts.parseJsonConfigFileContent(
            configFile.config,
            ts.sys,
            workspaceRoot
          );
          this.compilerOptions = { ...this.compilerOptions, ...parsed.options };
          console.info('[TypeScriptService] Loaded tsconfig.json');
        }
      } catch (error) {
        console.warn(`[TypeScriptService] Error loading tsconfig.json: ${error}`);
      }
    }

    this.createLanguageService();
    console.info('[TypeScriptService] Initialized with persistent LanguageService');
  }

  private getDefaultCompilerOptions(): ts.CompilerOptions {
    return {
      target: ts.ScriptTarget.Latest,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit.React,
      declaration: false,
      skipLibCheck: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      strict: false,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      isolatedModules: true,
      noEmit: true
    };
  }

  private createLanguageService(): void {
    this.serviceHost = {
      getScriptFileNames: () => Array.from(this.files.keys()),
      getScriptVersion: (fileName) => {
        const file = this.files.get(fileName);
        return file ? file.version.toString() : '0';
      },
      getScriptSnapshot: (fileName) => {
        // Return cached snapshot if available
        const file = this.files.get(fileName);
        if (file) {
          return file.snapshot;
        }
        
        // Try to read from disk and cache
        if (fs.existsSync(fileName)) {
          const content = fs.readFileSync(fileName, 'utf-8');
          const snapshot = ts.ScriptSnapshot.fromString(content);
          
          // Cache it for future use
          this.files.set(fileName, { version: 1, snapshot });
          return snapshot;
        }
        
        return undefined;
      },
      getCurrentDirectory: () => this.workspaceRoot,
      getCompilationSettings: () => this.compilerOptions,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories
    };

    this.languageService = ts.createLanguageService(this.serviceHost, this.documentRegistry);
  }

  /**
   * Update or add a file to the language service.
   * This uses incremental snapshots for efficient updates.
   */
  updateFile(fileName: string, content: string): void {
    const snapshot = ts.ScriptSnapshot.fromString(content);
    const existing = this.files.get(fileName);
    
    if (existing) {
      // Increment version for incremental compilation
      existing.version++;
      existing.snapshot = snapshot;
    } else {
      this.files.set(fileName, { version: 1, snapshot });
    }
  }

  /**
   * Remove a file from the language service.
   */
  removeFile(fileName: string): void {
    this.files.delete(fileName);
  }

  /**
   * Get definitions at a position using TypeScript LanguageService.
   */
  getDefinitionAtPosition(
    fileName: string,
    position: number
  ): readonly ts.DefinitionInfo[] | undefined {
    if (!this.languageService) {
      return undefined;
    }

    try {
      return this.languageService.getDefinitionAtPosition(fileName, position);
    } catch (error) {
      console.error(`[TypeScriptService] Error getting definition: ${error}`);
      return undefined;
    }
  }

  /**
   * Get references at a position using TypeScript LanguageService.
   */
  getReferencesAtPosition(
    fileName: string,
    position: number
  ): ts.ReferenceEntry[] | undefined {
    if (!this.languageService) {
      return undefined;
    }

    try {
      const referencedSymbols = this.languageService.findReferences(fileName, position);
      if (!referencedSymbols) {
        return undefined;
      }
      
      const refs: ts.ReferenceEntry[] = [];
      for (const refSymbol of referencedSymbols) {
        refs.push(...refSymbol.references);
      }
      return refs;
    } catch (error) {
      console.error(`[TypeScriptService] Error getting references: ${error}`);
      return undefined;
    }
  }

  /**
   * Get symbol at a position for detailed information.
   * This is optimized to reuse the cached program.
   */
  getSymbolAtPosition(
    fileName: string,
    position: number
  ): ts.Symbol | undefined {
    if (!this.languageService) {
      return undefined;
    }

    try {
      const program = this.languageService.getProgram();
      if (!program) {
        return undefined;
      }

      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile) {
        return undefined;
      }

      const typeChecker = program.getTypeChecker();
      const node = this.getNodeAtPosition(sourceFile, position);
      
      if (node) {
        return typeChecker.getSymbolAtLocation(node);
      }
    } catch (error) {
      console.error(`[TypeScriptService] Error getting symbol: ${error}`);
    }

    return undefined;
  }

  /**
   * Get detailed symbol information including parent container for disambiguation.
   * Returns symbol name, kind, and parent container information.
   */
  getSymbolDetails(
    fileName: string,
    position: number
  ): { name: string; kind: string; containerName?: string; containerKind?: string; isStatic?: boolean } | undefined {
    if (!this.languageService) {
      return undefined;
    }

    try {
      const program = this.languageService.getProgram();
      if (!program) {
        return undefined;
      }

      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile) {
        return undefined;
      }

      const typeChecker = program.getTypeChecker();
      const node = this.getNodeAtPosition(sourceFile, position);
      
      if (!node) {
        return undefined;
      }

      const symbol = typeChecker.getSymbolAtLocation(node);
      if (!symbol) {
        return undefined;
      }

      // Get symbol name and kind
      const name = symbol.getName();
      const kind = this.getSymbolKind(symbol);

      // Get parent container
      const parent = this.getParentSymbol(symbol, typeChecker);
      let containerName: string | undefined;
      let containerKind: string | undefined;

      if (parent) {
        containerName = parent.getName();
        containerKind = this.getSymbolKind(parent);
      }

      // Check if static
      const isStatic = this.isStaticMember(symbol);

      return {
        name,
        kind,
        containerName,
        containerKind,
        isStatic
      };
    } catch (error) {
      console.error(`[TypeScriptService] Error getting symbol details: ${error}`);
      return undefined;
    }
  }

  /**
   * Get parent symbol (container) for a given symbol.
   */
  private getParentSymbol(symbol: ts.Symbol, typeChecker: ts.TypeChecker): ts.Symbol | undefined {
    try {
      // Try to get parent from declarations
      if (symbol.declarations && symbol.declarations.length > 0) {
        const decl = symbol.declarations[0];
        
        // Find parent class, interface, or namespace
        let parent = decl.parent;
        while (parent) {
          if (ts.isClassDeclaration(parent) || 
              ts.isInterfaceDeclaration(parent) ||
              ts.isModuleDeclaration(parent) ||
              ts.isEnumDeclaration(parent)) {
            const parentSymbol = typeChecker.getSymbolAtLocation(parent.name!);
            if (parentSymbol) {
              return parentSymbol;
            }
          }
          parent = parent.parent;
        }
      }
    } catch (error) {
      // Ignore
    }
    return undefined;
  }

  /**
   * Determine symbol kind from TypeScript symbol.
   */
  private getSymbolKind(symbol: ts.Symbol): string {
    const flags = symbol.getFlags();
    
    if (flags & ts.SymbolFlags.Class) {
      return 'class';
    }
    if (flags & ts.SymbolFlags.Interface) {
      return 'interface';
    }
    if (flags & ts.SymbolFlags.TypeAlias) {
      return 'type';
    }
    if (flags & ts.SymbolFlags.Enum) {
      return 'enum';
    }
    if (flags & ts.SymbolFlags.Function) {
      return 'function';
    }
    if (flags & ts.SymbolFlags.Method) {
      return 'method';
    }
    if (flags & ts.SymbolFlags.Property) {
      return 'property';
    }
    if (flags & ts.SymbolFlags.Variable) {
      return 'variable';
    }
    if (flags & ts.SymbolFlags.BlockScopedVariable) {
      return 'constant';
    }
    
    return 'unknown';
  }

  /**
   * Check if a symbol is a static member.
   */
  private isStaticMember(symbol: ts.Symbol): boolean | undefined {
    try {
      if (symbol.declarations && symbol.declarations.length > 0) {
        const decl = symbol.declarations[0];
        
        if (ts.isMethodDeclaration(decl) || ts.isPropertyDeclaration(decl)) {
          return decl.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword) || false;
        }
      }
    } catch (error) {
      // Ignore
    }
    return undefined;
  }

  /**
   * Get the AST node at a specific position.
   */
  private getNodeAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
    function find(node: ts.Node): ts.Node | undefined {
      if (position >= node.getStart() && position < node.getEnd()) {
        return ts.forEachChild(node, find) || node;
      }
      return undefined;
    }
    return find(sourceFile);
  }

  /**
   * Get type information at position.
   */
  getTypeAtPosition(
    fileName: string,
    position: number
  ): ts.Type | undefined {
    if (!this.languageService) {
      return undefined;
    }

    try {
      const program = this.languageService.getProgram();
      if (!program) {
        return undefined;
      }

      const sourceFile = program.getSourceFile(fileName);
      if (!sourceFile) {
        return undefined;
      }

      const typeChecker = program.getTypeChecker();
      const node = this.getNodeAtPosition(sourceFile, position);
      
      if (node) {
        return typeChecker.getTypeAtLocation(node);
      }
    } catch (error) {
      console.error(`[TypeScriptService] Error getting type: ${error}`);
    }

    return undefined;
  }

  /**
   * Get parameter count for a function/method symbol.
   */
  getParameterCount(symbol: ts.Symbol): number | undefined {
    try {
      const type = symbol.valueDeclaration;
      if (type && (ts.isFunctionDeclaration(type) || 
                   ts.isMethodDeclaration(type) || 
                   ts.isFunctionExpression(type) ||
                   ts.isArrowFunction(type))) {
        return type.parameters.length;
      }
    } catch (error) {
      // Ignore
    }
    return undefined;
  }

  /**
   * Check if the service is initialized.
   */
  isInitialized(): boolean {
    return this.languageService !== null;
  }

  /**
   * Get the current program (for advanced use cases).
   * This is cached and incrementally updated.
   */
  getProgram(): ts.Program | undefined {
    return this.languageService?.getProgram();
  }

  /**
   * Dispose of the language service.
   */
  dispose(): void {
    this.languageService?.dispose();
    this.languageService = null;
    this.serviceHost = null;
    this.files.clear();
  }
}
