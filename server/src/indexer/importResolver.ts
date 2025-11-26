import * as path from 'path';
import * as fs from 'fs';
import * as ts from 'typescript';
import { ImportInfo } from '../types.js';

interface PathMapping {
  pattern: string;
  paths: string[];
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

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.loadTsConfig();
  }

  /**
   * Load tsconfig.json and extract path mappings and baseUrl.
   */
  private loadTsConfig(): void {
    const tsconfigPath = path.join(this.workspaceRoot, 'tsconfig.json');
    
    if (!fs.existsSync(tsconfigPath)) {
      return;
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
      console.warn(`[ImportResolver] Error loading tsconfig.json: ${error}`);
    }
  }

  /**
   * Resolve a module specifier to an absolute file path.
   * 
   * @param moduleSpecifier - e.g., './foo', '../bar', '@angular/core', '@app/utils'
   * @param fromFile - absolute path of the importing file
   * @returns resolved absolute file path, or null if cannot be resolved
   */
  resolveImport(moduleSpecifier: string, fromFile: string): string | null {
    // Handle relative imports
    if (moduleSpecifier.startsWith('./') || moduleSpecifier.startsWith('../')) {
      return this.resolveRelativeImport(moduleSpecifier, fromFile);
    }

    // Try path mappings first (e.g., @app/* -> src/*)
    const pathMappingResult = this.resolvePathMapping(moduleSpecifier);
    if (pathMappingResult) {
      return pathMappingResult;
    }

    // Try node_modules resolution
    const nodeModulesResult = this.resolveNodeModules(moduleSpecifier, fromFile);
    if (nodeModulesResult) {
      return nodeModulesResult;
    }

    // Try using TypeScript's module resolution
    return this.resolveWithTypeScript(moduleSpecifier, fromFile);
  }

  /**
   * Resolve relative imports (e.g., './foo', '../bar/baz').
   */
  private resolveRelativeImport(moduleSpecifier: string, fromFile: string): string | null {
    const fromDir = path.dirname(fromFile);
    const basePath = path.resolve(fromDir, moduleSpecifier);

    return this.tryResolveFile(basePath);
  }

  /**
   * Resolve using tsconfig path mappings.
   */
  private resolvePathMapping(moduleSpecifier: string): string | null {
    for (const mapping of this.pathMappings) {
      const pattern = mapping.pattern.replace('*', '(.*)');
      const regex = new RegExp(`^${pattern}$`);
      const match = moduleSpecifier.match(regex);

      if (match) {
        const captured = match[1] || '';
        
        for (const mappedPath of mapping.paths) {
          const resolvedPath = mappedPath.replace('*', captured);
          const result = this.tryResolveFile(resolvedPath);
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
  private resolveNodeModules(moduleSpecifier: string, fromFile: string): string | null {
    let currentDir = path.dirname(fromFile);

    while (true) {
      const nodeModulesPath = path.join(currentDir, 'node_modules', moduleSpecifier);
      
      // Try to resolve as a file
      const fileResult = this.tryResolveFile(nodeModulesPath);
      if (fileResult) {
        return fileResult;
      }

      // Try to resolve as a package with package.json
      const packageJsonPath = path.join(nodeModulesPath, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        try {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
          const mainField = packageJson.types || packageJson.typings || packageJson.module || packageJson.main;
          
          if (mainField) {
            const mainPath = path.join(nodeModulesPath, mainField);
            const result = this.tryResolveFile(mainPath);
            if (result) {
              return result;
            }
          }
        } catch (error) {
          // Ignore package.json parsing errors
        }
      }

      // Try index file
      const indexResult = this.tryResolveFile(path.join(nodeModulesPath, 'index'));
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
   */
  private tryResolveFile(basePath: string): string | null {
    // Try with various extensions
    const extensions = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];
    
    // Try as file with extensions
    for (const ext of extensions) {
      const filePath = basePath + ext;
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }

    // Try as directory with index file
    for (const ext of extensions) {
      const indexPath = path.join(basePath, 'index' + ext);
      if (fs.existsSync(indexPath)) {
        return indexPath;
      }
    }

    // Try exact path (might already have extension)
    if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
      return basePath;
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
