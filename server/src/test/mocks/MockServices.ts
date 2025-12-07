/**
 * Mock Services - Test doubles for handler dependencies.
 * 
 * Provides minimal implementations of LSP services for unit testing.
 */

import { Connection, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ServerServices, ServerState } from '../../handlers/types.js';
import { MockIndex } from './MockIndex.js';
import { Profiler } from '../../profiler/profiler.js';
import { StatsManager } from '../../index/statsManager.js';

/**
 * Create a minimal mock connection for testing.
 */
export function createMockConnection(): Connection {
  const mockConnection = {
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
      info: () => {}
    },
    onDefinition: () => {},
    onHover: () => {},
    onPrepareRename: () => {},
    onRenameRequest: () => {},
    onReferences: () => {},
    onDocumentSymbol: () => {},
    onWorkspaceSymbol: () => {},
    onCompletion: () => {},
    sendNotification: () => {},
    sendRequest: () => Promise.resolve(null)
  };

  return mockConnection as unknown as Connection;
}

/**
 * Create a mock text documents manager.
 */
export function createMockDocuments(documents: Map<string, string> = new Map()): TextDocuments<TextDocument> {
  const mockDocuments = {
    get: (uri: string) => {
      const content = documents.get(uri);
      if (!content) {
        return undefined;
      }

      return TextDocument.create(uri, 'typescript', 1, content);
    },
    all: () => {
      const result: TextDocument[] = [];
      for (const [uri, content] of documents) {
        result.push(TextDocument.create(uri, 'typescript', 1, content));
      }
      return result;
    },
    keys: () => Array.from(documents.keys()),
    listen: () => {},
    onDidOpen: () => ({ dispose: () => {} }),
    onDidClose: () => ({ dispose: () => {} }),
    onDidChangeContent: () => ({ dispose: () => {} }),
    onDidSave: () => ({ dispose: () => {} }),
    onWillSave: () => ({ dispose: () => {} })
  };

  return mockDocuments as unknown as TextDocuments<TextDocument>;
}

/**
 * Create mock server services for testing.
 */
export function createMockServices(
  mergedIndex: MockIndex,
  documents?: Map<string, string>
): Partial<ServerServices> {
  return {
    connection: createMockConnection(),
    documents: createMockDocuments(documents),
    mergedIndex: mergedIndex as any,
    profiler: new Profiler(),
    statsManager: new StatsManager(),
    typeScriptService: {
      isInitialized: () => false,
      getSymbolDetails: () => null
    } as any,
    workspaceRoot: '/test/workspace'
  };
}

/**
 * Create mock server state for testing.
 */
export function createMockState(): ServerState {
  return {
    workspaceRoot: '/test/workspace',
    hasConfigurationCapability: false,
    hasWorkspaceFolderCapability: false,
    importResolver: null,
    deadCodeDetector: null,
    fileWatcher: null
  };
}
