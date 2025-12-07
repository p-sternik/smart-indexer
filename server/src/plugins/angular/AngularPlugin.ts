import { AST_NODE_TYPES, TSESTree } from '@typescript-eslint/typescript-estree';
import { FrameworkPlugin, PluginVisitorContext, PluginVisitResult } from '../FrameworkPlugin.js';
import { IndexedSymbol } from '../../types.js';

/**
 * Angular lifecycle hooks that are called by the framework, not by user code.
 * These should be protected from dead code detection.
 */
const ANGULAR_LIFECYCLE_HOOKS = new Set([
  'ngOnInit',
  'ngOnChanges',
  'ngDoCheck',
  'ngAfterContentInit',
  'ngAfterContentChecked',
  'ngAfterViewInit',
  'ngAfterViewChecked',
  'ngOnDestroy'
]);

/**
 * Angular lifecycle interfaces that may appear in type positions.
 */
const ANGULAR_LIFECYCLE_INTERFACES = new Set([
  'OnInit',
  'OnChanges',
  'DoCheck',
  'AfterContentInit',
  'AfterContentChecked',
  'AfterViewInit',
  'AfterViewChecked',
  'OnDestroy'
]);

/**
 * Angular decorators that mark classes as framework-managed.
 */
const ANGULAR_CLASS_DECORATORS = new Set([
  'Component',
  'Directive',
  'Injectable',
  'NgModule',
  'Pipe'
]);

/**
 * Angular member decorators.
 */
const ANGULAR_MEMBER_DECORATORS = new Set([
  'Input',
  'Output',
  'ViewChild',
  'ViewChildren',
  'ContentChild',
  'ContentChildren',
  'HostBinding',
  'HostListener'
]);

/**
 * AngularPlugin - Handles Angular-specific indexing logic.
 * 
 * Responsibilities:
 * - Detect @Component, @Directive, @Injectable, etc. decorators
 * - Protect Angular lifecycle hooks from dead code detection
 * - Extract Angular-specific metadata
 */
export class AngularPlugin implements FrameworkPlugin {
  readonly name = 'angular';

  /**
   * Check if a class has an Angular decorator.
   */
  private hasAngularDecorator(node: TSESTree.ClassDeclaration): string | undefined {
    if (!node.decorators || node.decorators.length === 0) {
      return undefined;
    }

    for (const decorator of node.decorators) {
      let decoratorName: string | undefined;

      if (decorator.expression.type === AST_NODE_TYPES.Identifier) {
        decoratorName = decorator.expression.name;
      } else if (
        decorator.expression.type === AST_NODE_TYPES.CallExpression &&
        decorator.expression.callee.type === AST_NODE_TYPES.Identifier
      ) {
        decoratorName = decorator.expression.callee.name;
      }

      if (decoratorName && ANGULAR_CLASS_DECORATORS.has(decoratorName)) {
        return decoratorName;
      }
    }

    return undefined;
  }

  /**
   * Check if a member has an Angular decorator.
   */
  private hasAngularMemberDecorator(
    node: TSESTree.MethodDefinition | TSESTree.PropertyDefinition
  ): string | undefined {
    if (!node.decorators || node.decorators.length === 0) {
      return undefined;
    }

    for (const decorator of node.decorators) {
      let decoratorName: string | undefined;

      if (decorator.expression.type === AST_NODE_TYPES.Identifier) {
        decoratorName = decorator.expression.name;
      } else if (
        decorator.expression.type === AST_NODE_TYPES.CallExpression &&
        decorator.expression.callee.type === AST_NODE_TYPES.Identifier
      ) {
        decoratorName = decorator.expression.callee.name;
      }

      if (decoratorName && ANGULAR_MEMBER_DECORATORS.has(decoratorName)) {
        return decoratorName;
      }
    }

    return undefined;
  }

  visitNode(
    node: TSESTree.Node,
    _currentSymbol: IndexedSymbol | null,
    _context: PluginVisitorContext
  ): PluginVisitResult | undefined {
    // Handle class declarations with Angular decorators
    if (node.type === AST_NODE_TYPES.ClassDeclaration) {
      const decorator = this.hasAngularDecorator(node);
      if (decorator) {
        return {
          metadata: {
            angular: {
              decorator,
              isComponent: decorator === 'Component',
              isDirective: decorator === 'Directive',
              isInjectable: decorator === 'Injectable',
              isModule: decorator === 'NgModule',
              isPipe: decorator === 'Pipe'
            }
          }
        };
      }
    }

    // Handle method/property definitions with Angular decorators
    if (
      node.type === AST_NODE_TYPES.MethodDefinition ||
      node.type === AST_NODE_TYPES.PropertyDefinition
    ) {
      const decorator = this.hasAngularMemberDecorator(node);
      if (decorator) {
        return {
          metadata: {
            angular: {
              memberDecorator: decorator,
              isInput: decorator === 'Input',
              isOutput: decorator === 'Output'
            }
          }
        };
      }
    }

    return undefined;
  }

  /**
   * Determine if a symbol is an Angular entry point.
   * Angular lifecycle hooks and decorated classes are framework-managed.
   */
  isEntryPoint(symbol: IndexedSymbol): boolean {
    // Lifecycle hooks are always entry points
    if (ANGULAR_LIFECYCLE_HOOKS.has(symbol.name)) {
      return true;
    }

    // Lifecycle interfaces are always entry points
    if (ANGULAR_LIFECYCLE_INTERFACES.has(symbol.name)) {
      return true;
    }

    // Check for Angular metadata
    const angularMeta = symbol.metadata?.['angular'] as Record<string, unknown> | undefined;
    if (angularMeta) {
      // Decorated classes are entry points
      if (angularMeta['decorator']) {
        return true;
      }
      // @Input/@Output properties are entry points
      if (angularMeta['isInput'] || angularMeta['isOutput']) {
        return true;
      }
    }

    return false;
  }

  extractMetadata(
    symbol: IndexedSymbol,
    _node: TSESTree.Node
  ): Record<string, unknown> | undefined {
    // Check if this is a lifecycle hook
    if (
      symbol.kind === 'method' &&
      ANGULAR_LIFECYCLE_HOOKS.has(symbol.name)
    ) {
      return {
        angular: {
          isLifecycleHook: true,
          hookName: symbol.name
        }
      };
    }

    return undefined;
  }
}
