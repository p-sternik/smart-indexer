/**
 * HandlerRegistry - Centralized management of LSP request handlers.
 * 
 * This registry:
 * - Provides dependency injection for all handlers
 * - Manages handler lifecycle (registration, disposal)
 * - Ensures single-point-of-truth for server state
 * 
 * Usage:
 * ```typescript
 * const registry = new HandlerRegistry(services, state);
 * registry.register(InitializationHandler);
 * registry.register(DefinitionHandler);
 * // ... register other handlers
 * 
 * // During shutdown:
 * await registry.disposeAll();
 * ```
 */

import { 
  IHandler, 
  HandlerFactory, 
  ServerServices, 
  ServerState 
} from './types.js';

/**
 * Registry for managing LSP request handlers.
 * Provides a clean dependency injection mechanism and lifecycle management.
 */
export class HandlerRegistry {
  private handlers: Map<string, IHandler> = new Map();
  private services: ServerServices;
  private state: ServerState;

  constructor(services: ServerServices, state: ServerState) {
    this.services = services;
    this.state = state;
  }

  /**
   * Register a handler using a factory function.
   * The factory receives services and state for dependency injection.
   * 
   * @param factory - Factory function that creates the handler
   * @returns The created handler instance
   */
  register<T extends IHandler>(factory: HandlerFactory<T>): T {
    const handler = factory(this.services, this.state);
    
    if (this.handlers.has(handler.name)) {
      this.services.logger.warn(
        `[HandlerRegistry] Handler "${handler.name}" already registered, replacing...`
      );
    }
    
    this.handlers.set(handler.name, handler);
    handler.register();
    
    this.services.connection.console.info(
      `[HandlerRegistry] Registered handler: ${handler.name}`
    );
    
    return handler;
  }

  /**
   * Get a registered handler by name.
   * 
   * @param name - Handler name
   * @returns The handler instance or undefined if not found
   */
  get<T extends IHandler>(name: string): T | undefined {
    return this.handlers.get(name) as T | undefined;
  }

  /**
   * Check if a handler is registered.
   * 
   * @param name - Handler name
   * @returns True if the handler is registered
   */
  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /**
   * Get all registered handler names.
   * 
   * @returns Array of handler names
   */
  getHandlerNames(): string[] {
    return Array.from(this.handlers.keys());
  }

  /**
   * Dispose of all handlers.
   * Should be called during server shutdown.
   */
  async disposeAll(): Promise<void> {
    this.services.connection.console.info(
      `[HandlerRegistry] Disposing ${this.handlers.size} handlers...`
    );
    
    const disposePromises: Promise<void>[] = [];
    
    for (const [name, handler] of this.handlers) {
      if (handler.dispose) {
        disposePromises.push(
          handler.dispose().catch((error) => {
            this.services.logger.error(
              `[HandlerRegistry] Error disposing handler "${name}": ${error}`
            );
          })
        );
      }
    }
    
    await Promise.all(disposePromises);
    this.handlers.clear();
    
    this.services.connection.console.info(
      `[HandlerRegistry] All handlers disposed`
    );
  }

  /**
   * Update the services reference.
   * Useful when services are created after registry initialization.
   */
  updateServices(partialServices: Partial<ServerServices>): void {
    Object.assign(this.services, partialServices);
  }

  /**
   * Get the current server state.
   * Handlers can read state directly but should use this for mutations.
   */
  getState(): ServerState {
    return this.state;
  }

  /**
   * Update server state.
   * 
   * @param updater - Function that receives current state and returns updates
   */
  updateState(updater: (state: ServerState) => Partial<ServerState>): void {
    const updates = updater(this.state);
    Object.assign(this.state, updates);
  }
}
