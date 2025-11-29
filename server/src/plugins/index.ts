/**
 * Plugin system exports
 */
export { FrameworkPlugin, PluginRegistry, PluginVisitorContext, PluginVisitResult, pluginRegistry } from './FrameworkPlugin.js';
export { AngularPlugin } from './angular/AngularPlugin.js';
export { NgRxPlugin, NgRxSymbolMetadata } from './ngrx/NgRxPlugin.js';

import { pluginRegistry } from './FrameworkPlugin.js';
import { AngularPlugin } from './angular/AngularPlugin.js';
import { NgRxPlugin } from './ngrx/NgRxPlugin.js';

/**
 * Initialize the default plugins.
 * Call this during server startup.
 */
export function initializeDefaultPlugins(): void {
  pluginRegistry.register(new AngularPlugin());
  pluginRegistry.register(new NgRxPlugin());
}
