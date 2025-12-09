/**
 * NgRxContextDetector - Context-aware NgRx pattern detection.
 * 
 * Provides intelligent detection of NgRx artifacts to enable "loose mode" search
 * only for NgRx-specific patterns, preventing false positives in non-NgRx code.
 * 
 * Strategy:
 * 1. Check for @ngrx imports (safety gate)
 * 2. Detect NgRx-specific patterns (createAction, dispatch, ofType)
 * 3. Enable relaxed filters only when both conditions are met
 */

/**
 * Check if file content contains NgRx imports.
 * Safety gate: ensures we only enable loose mode for actual NgRx projects.
 */
export function isNgRxContext(fileContent: string): boolean {
  // Check for @ngrx package imports
  const ngrxImportPatterns = [
    /@ngrx\/store/,
    /@ngrx\/effects/,
    /@ngrx\/entity/,
    /@ngrx\/router-store/,
    /@ngrx\/component-store/
  ];
  
  return ngrxImportPatterns.some(pattern => pattern.test(fileContent));
}

/**
 * Check if a symbol name follows NgRx action naming conventions.
 * Typical patterns: loadUsers, saveProduct, updateCart, deleteItem
 */
export function isNgRxActionName(symbolName: string): boolean {
  if (!symbolName || symbolName.length < 3) {
    return false;
  }
  
  // NgRx action conventions: camelCase starting with CRUD verbs
  const ngrxActionPrefixes = [
    'load', 'save', 'update', 'delete', 'create', 'remove',
    'add', 'set', 'clear', 'reset', 'fetch', 'submit',
    'navigate', 'select', 'deselect', 'toggle', 'open', 'close'
  ];
  
  const lowerName = symbolName.toLowerCase();
  
  // Check if starts with known prefix AND is camelCase
  const startsWithPrefix = ngrxActionPrefixes.some(prefix => lowerName.startsWith(prefix));
  const isCamelCase = /^[a-z][a-zA-Z0-9]*$/.test(symbolName);
  
  return startsWithPrefix && isCamelCase;
}

/**
 * Check if line content contains NgRx-specific patterns.
 */
export function isNgRxSymbol(symbolName: string, lineContent: string): boolean {
  // Pattern 1: Action creator calls
  if (lineContent.includes('createAction')) {
    return true;
  }
  
  // Pattern 2: Action group definitions
  if (lineContent.includes('createActionGroup')) {
    return true;
  }
  
  // Pattern 3: Effect patterns
  if (lineContent.includes('createEffect')) {
    return true;
  }
  
  // Pattern 4: Reducer patterns
  if (lineContent.includes('on(') || lineContent.includes('on (')) {
    return true;
  }
  
  // Pattern 5: Effect patterns with ofType
  if (lineContent.includes('ofType(') || lineContent.includes('ofType (')) {
    return true;
  }
  
  // Pattern 6: Dispatch patterns
  if (lineContent.includes('.dispatch(')) {
    return true;
  }
  
  // Pattern 7: props() for action payloads
  if (lineContent.includes('props<') && lineContent.includes('createAction')) {
    return true;
  }
  
  // Pattern 8: Action naming convention
  if (isNgRxActionName(symbolName)) {
    return true;
  }
  
  return false;
}

/**
 * Determine if loose mode should be enabled for this search.
 * Loose mode allows variable declarations and bypasses strict import guards.
 */
export function shouldEnableLooseMode(
  fileContent: string,
  symbolName: string,
  lineContent: string
): boolean {
  // Safety: Must have @ngrx imports
  if (!isNgRxContext(fileContent)) {
    return false;
  }
  
  // Pattern detection: Must match NgRx patterns
  return isNgRxSymbol(symbolName, lineContent);
}

/**
 * Extract NgRx action type string from action creator.
 * Example: createAction('[User] Load') -> '[User] Load'
 */
export function extractActionTypeString(lineContent: string): string | null {
  // Match string literals in createAction calls
  const matches = lineContent.match(/createAction\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (matches && matches[1]) {
    return matches[1];
  }
  
  // Try to match in variable declarations
  const varMatches = lineContent.match(/=\s*createAction\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (varMatches && varMatches[1]) {
    return varMatches[1];
  }
  
  return null;
}

/**
 * Calculate confidence level for NgRx reference matches.
 */
export type NgRxConfidence = 'high' | 'medium' | 'low';

export function calculateNgRxConfidence(
  matchType: 'symbol' | 'string' | 'wildcard',
  hasExplicitImport: boolean
): NgRxConfidence {
  if (matchType === 'symbol' && hasExplicitImport) {
    return 'high'; // Explicit import and symbol match
  }
  
  if (matchType === 'symbol' && !hasExplicitImport) {
    return 'medium'; // Symbol match but wildcard import (e.g., * as Actions)
  }
  
  if (matchType === 'string') {
    return 'medium'; // String literal match in reducer/effect
  }
  
  return 'low'; // Wildcard or loose match
}

/**
 * Check if a file likely contains NgRx reducers or effects.
 * Used to determine if string literal matching should be applied.
 */
export function isNgRxReducerOrEffect(fileContent: string): boolean {
  // Reducer patterns
  const hasReducer = /createReducer|on\(/.test(fileContent);
  
  // Effect patterns
  const hasEffect = /createEffect|ofType\(/.test(fileContent);
  
  return hasReducer || hasEffect;
}

/**
 * Parse action group member access.
 * Example: "PageActions.load" -> { container: "PageActions", member: "load" }
 */
export function parseActionGroupAccess(expression: string): {
  container: string;
  member: string;
} | null {
  const match = expression.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\.\s*([a-zA-Z_$][a-zA-Z0-9_$]*)$/);
  
  if (match) {
    return {
      container: match[1],
      member: match[2]
    };
  }
  
  return null;
}

/**
 * Check if symbol is likely an NgRx action group container.
 * Example: const PageActions = createActionGroup(...)
 */
export function isActionGroupContainer(symbolName: string, lineContent: string): boolean {
  // Must end with "Actions" or "Action"
  if (!symbolName.endsWith('Actions') && !symbolName.endsWith('Action')) {
    return false;
  }
  
  // Must have createActionGroup in the line
  if (!lineContent.includes('createActionGroup')) {
    return false;
  }
  
  return true;
}
