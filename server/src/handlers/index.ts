/**
 * Handlers Module - LSP Request Handlers
 * 
 * This module exports all handler components for the Smart Indexer language server.
 * Handlers are responsible for processing specific LSP requests and notifications.
 * 
 * Architecture:
 * - Each handler is a self-contained class implementing IHandler
 * - Dependencies are injected via constructor (ServerServices, ServerState)
 * - HandlerRegistry manages handler lifecycle (registration, disposal)
 * 
 * Usage in server.ts:
 * ```typescript
 * import { HandlerRegistry, createInitializationHandler } from './handlers/index.js';
 * 
 * const registry = new HandlerRegistry(services, state);
 * registry.register(createInitializationHandler);
 * // ... register other handlers
 * ```
 */

// Types and interfaces
export * from './types.js';

// Registry
export { HandlerRegistry } from './HandlerRegistry.js';

// Handlers
export { 
  InitializationHandler, 
  createInitializationHandler 
} from './InitializationHandler.js';

export {
  DefinitionHandler,
  createDefinitionHandler
} from './definitionHandler.js';

export {
  ReferencesHandler,
  createReferencesHandler
} from './referencesHandler.js';

// Future handlers (to be implemented):
// export { CompletionHandler, createCompletionHandler } from './CompletionHandler.js';
// export { WorkspaceSymbolHandler, createWorkspaceSymbolHandler } from './WorkspaceSymbolHandler.js';
// export { DocumentHandler, createDocumentHandler } from './DocumentHandler.js';
// export { CommandsHandler, createCommandsHandler } from './CommandsHandler.js';
