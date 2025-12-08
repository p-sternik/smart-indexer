import * as path from 'path';
import * as fsPromises from 'fs/promises';
import * as ts from 'typescript';
import { ImportInfo } from '../types.js';

interface PathMapping {
  pattern: string;
  paths: string[];
}

/**
 * Cache entry for config files (tsconfig.json, package.json)
 */
interface ConfigCacheEntry<T> {
  data: T;
  timestamp: number;
}

/**
 * Resolves import module specifiers to file paths.
 * Handles relative imports, node_modules, and tsconfig path aliases.
 */
export class ImportResolver {
  private workspaceRoot: string;
  private pathMappings: PathMapping[] = [];
  private baseUrl: string = '';
  private compilerOptions: ts.CompilerOptions = {};
  
  /** TTL for config file cache in milliseconds (10 seconds) */
  private static readonly CONFIG_CACHE_TTL = 10_000;
  
  /** Cache for tsconfig.json files */
  private tsconfigCache = new Map<string, ConfigCacheEntry<ts.ParsedCommandLine | null>>();
  
  /** Cache for package.json files */
  private packageJsonCache = new Map<string, ConfigCacheEntry<any | null>>();
  
  /** Cache for file existence checks */
  private existsCache = new Map<string, ConfigCacheEntry<boolean>>();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Async initialization - must be called after construction
   */
  async init(): Promise<void> {
    await this.loadTsConfig();
  }

  /**
   * Load tsconfig.json and extract path mappings and baseUrl.
   */
  private async loadTsConfig(): Promise<void> {
    const tsconfigPath = path.join(this.workspaceRoot, 'tsconfig.json');
    
    try {
      await fsPromises.access(tsconfigPath);
    } catch {
      return; // File doesn't exist
    }

    try {
      const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
      if (!configFile.config) {
        return;
      }

      const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        this.workspaceRoot
      );

      this.compilerOptions = parsed.options;
      this.baseUrl = this.compilerOptions.baseUrl 
        ? path.resolve(this.workspaceRoot, this.compilerOptions.baseUrl)
        : this.workspaceRoot;

      // Extract path mappings
      if (this.compilerOptions.paths) {
        for (const [pattern, paths] of Object.entries(this.compilerOptions.paths)) {
          this.pathMappings.push({
            pattern,
            paths: paths.map(p => path.resolve(this.baseUrl, p))
          });
        }
      }

      console.info(`[ImportResolver] Loaded tsconfig.json: baseUrl=${this.baseUrl}, ${this.pathMappings.length} path mappings`);
    } catch (error) {
      // Silent fail - tsconfig is optional
    }
  }

  /**
   * Invalidate config caches (call when files change)
   */
  invalidateCache(filePath?: string): void {
    if (filePath) {
      const normalizedPath = path.normalize(filePath);
      if (normalizedPath.endsWith('tsconfig.json')) {
        this.tsconfigCache.delete(normalizedPath);
      } else if (normalizedPath.endsWith('package.json')) {
        this.packageJsonCache.delete(normalizedPath);
      }
      this.existsCache.delete(normalizedPath);
    } else {
      // Invalidate all caches
      this.tsconfigCache.clear();
      this.packageJsonCache.clear();
      this.existsCache.clear();
    }
  }

  /**
   * Check if a cached entry is still valid
   */
  private isCacheValid<T>(entry: ConfigCacheEntry<T> | undefined): entry is ConfigCacheEntry<T> {
    if (!entry) {
      return false;
    }
    return (Date.now() - entry.timestamp) < ImportResolver.CONFIG_CACHE_TTL;
  }

  /**
   * Check if file exists with caching
   */
  private async fileExistsAsync(filePath: string): Promise<boolean> {
    const cached = this.existsCache.get(filePath);
    if (this.isCacheValid(cached)) {
      return cached.data;
    }
    
    try {
      await fsPromises.access(filePath);
      this.existsCache.set(filePath, { data: true, timestamp: Date.now() });
      return true;
    } catch {
      this.existsCache.set(filePath, { data: false, timestamp: Date.now() });
      return false;
    }
  }

  /**
   * Get file stats with error handling
   */
  private async statAsync(filePath: string): Promise<{ isFile: boolean } | null> {
    try {
      const stat = await fsPromises.stat(filePath);
      return { isFile: stat.isFile() };
    } catch {
      return null;
    }
  }

  /**
   * Read package.json with caching
   */
  private async readPackageJsonAsync(packageJsonPath: string): Promise<any | null> {
    const cached = this.packageJsonCache.get(packageJsonPath);
    if (this.isCacheValid(cached)) {
      return cached.data;
    }
    
    try {
      const content = await fsPromises.readFile(packageJsonPath, 'utf-8');
      const data = JSON.parse(content);
      this.packageJsonCache.set(packageJsonPath, { data, timestamp: Date.now() });
      return data;
    } catch {
      this.packageJsonCache.set(packageJsonPath, { data: null, timestamp: Date.now() });
      return null;
    }
  }

  /**
   * Resolve a module specifier to an absolute file path.
   * 
   * @param moduleSpecifier - e.g., './foo', '../bar', '@angular/core', '@app/utils'
   * @param fromFile - absolute path of the importing file
   * @returns resolved absolute file path, or null if cannot be resolved
   */
  async resolveImport(moduleSpecifier: string, fromFile: string): Promise<string | null> {
    // Handle relative imports
    if (moduleSpecifier.startsWith('./') || moduleSpecifier.startsWith('../')) {
      return this.resolveRelativeImport(moduleSpecifier, fromFile);
    }

    // Try path mappings first (e.g., @app/* -> src/*)
    const pathMappingResult = await this.resolvePathMapping(moduleSpecifier);
    if (pathMappingResult) {
      return pathMappingResult;
    }

    // Try node_modules resolution
    const nodeModulesResult = await this.resolveNodeModules(moduleSpecifier, fromFile);
    if (nodeModulesResult) {
      return nodeModulesResult;
    }

    // Try using TypeScript's module resolution
    return this.resolveWithTypeScript(moduleSpecifier, fromFile);
  }

  /**
   * Resolve relative imports (e.g., './foo', '../bar/baz').
   */
  private async resolveRelativeImport(moduleSpecifier: string, fromFile: string): Promise<string | null> {
    const fromDir = path.dirname(fromFile);
    const basePath = path.resolve(fromDir, moduleSpecifier);

    return this.tryResolveFile(basePath);
  }

  /**
   * Resolve using tsconfig path mappings.
   */
  private async resolvePathMapping(moduleSpecifier: string): Promise<string | null> {
    for (const mapping of this.pathMappings) {
      const pattern = mapping.pattern.replace('*', '(.*)');
      const regex = new RegExp(`^${pattern}$`);
      const match = moduleSpecifier.match(regex);

      if (match) {
        const captured = match[1] || '';
        
        for (const mappedPath of mapping.paths) {
          const resolvedPath = mappedPath.replace('*', captured);
          const result = await this.tryResolveFile(resolvedPath);
          if (result) {
            return result;
          }
        }
      }
    }

    return null;
  }

  /**
   * Resolve from node_modules.
   */
  private async resolveNodeModules(moduleSpecifier: string, fromFile: string): Promise<string | null> {
    let currentDir = path.dirname(fromFile);

    while (true) {
      const nodeModulesPath = path.join(currentDir, 'node_modules', moduleSpecifier);
      
      // Try to resolve as a file
      const fileResult = await this.tryResolveFile(nodeModulesPath);
      if (fileResult) {
        return fileResult;
      }

      // Try to resolve as a package with package.json
      const packageJsonPath = path.join(nodeModulesPath, 'package.json');
      if (await this.fileExistsAsync(packageJsonPath)) {
        const packageJson = await this.readPackageJsonAsync(packageJsonPath);
        if (packageJson) {
          const mainField = packageJson.types || packageJson.typings || packageJson.module || packageJson.main;
          
          if (mainField) {
            const mainPath = path.join(nodeModulesPath, mainField);
            const result = await this.tryResolveFile(mainPath);
            if (result) {
              return result;
            }
          }
        }
      }

      // Try index file
      const indexResult = await this.tryResolveFile(path.join(nodeModulesPath, 'index'));
      if (indexResult) {
        return indexResult;
      }

      // Move up to parent directory
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir || parentDir === this.workspaceRoot) {
        break;
      }
      currentDir = parentDir;
    }

    return null;
  }

  /**
   * Use TypeScript's module resolution API as fallback.
   */
  private resolveWithTypeScript(moduleSpecifier: string, fromFile: string): string | null {
    try {
      const result = ts.resolveModuleName(
        moduleSpecifier,
        fromFile,
        this.compilerOptions,
        ts.sys
      );

      if (result.resolvedModule) {
        return result.resolvedModule.resolvedFileName;
      }
    } catch (error) {
      // Fallback failed
    }

    return null;
  }

  /**
   * Try to resolve a base path as a file with various extensions.
   * Handles ESM imports with .js extensions that map to .ts/.tsx source files.
   */
  private async tryResolveFile(basePath: string): Promise<string | null> {
    const extensions = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
    
    // ESM Fix: If basePath ends with .js, try the TypeScript source equivalents first
    if (basePath.endsWith('.js')) {
      const basePathWithoutExt = basePath.slice(0, -3);
      
      // Try .ts and .tsx for ESM imports (e.g., import './foo.js' -> foo.ts)
      for (const ext of ['.ts', '.tsx']) {
        const filePath = basePathWithoutExt + ext;
        if (await this.fileExistsAsync(filePath)) {
          return filePath;
        }
      }
    }
    
    // Try exact path first (might already have extension)
    const stat = await this.statAsync(basePath);
    if (stat?.isFile) {
      return basePath;
    }
    
    // Try with various extensions
    for (const ext of extensions) {
      const filePath = basePath + ext;
      if (await this.fileExistsAsync(filePath)) {
        return filePath;
      }
    }

    // Try as directory with index file
    for (const ext of extensions) {
      const indexPath = path.join(basePath, 'index' + ext);
      if (await this.fileExistsAsync(indexPath)) {
        return indexPath;
      }
    }

    return null;
  }

  /**
   * Given a list of imports and a symbol name, find which import it comes from.
   */
  findImportForSymbol(symbolName: string, imports: ImportInfo[]): ImportInfo | null {
    return imports.find(imp => imp.localName === symbolName) || null;
  }
}
