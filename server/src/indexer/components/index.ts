/**
 * Worker Components - Modular components for AST parsing and symbol extraction.
 * 
 * This module exports focused classes that handle specific aspects of
 * the indexing pipeline, making the worker code more maintainable.
 */

export { StringInterner } from './StringInterner.js';
export { ScopeTracker } from './ScopeTracker.js';
export { AstParser, astParser } from './AstParser.js';
export { ImportExtractor } from './ImportExtractor.js';
export {
  isNgRxCreateActionCall,
  isNgRxCreateActionGroupCall,
  isNgRxCreateEffectCall,
  isNgRxOnCall,
  isNgRxOfTypeCall,
  extractActionTypeString,
  hasActionInterface,
  hasEffectDecorator,
  processCreateActionGroup
} from './NgRxUtils.js';
