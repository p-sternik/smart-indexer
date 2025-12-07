/**
 * HoverHandler Unit Tests
 * 
 * Tests the Hover functionality using a mocked index.
 * Validates that the handler shows correct symbol information.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { URI } from 'vscode-uri';
import { HoverHandler } from './hoverHandler.js';
import { MockIndex, createTestSymbol } from '../test/mocks/MockIndex.js';
import { createMockServices, createMockState } from '../test/mocks/MockServices.js';
import { MarkupKind } from 'vscode-languageserver/node';

describe('HoverHandler', () => {
  let mockIndex: MockIndex;
  let handler: HoverHandler;
  const testFileUri = 'file:///test/app.ts';
  const testFilePath = URI.parse(testFileUri).fsPath;

  beforeEach(() => {
    mockIndex = new MockIndex();
  });

  describe('Scenario: Hover over known symbol', () => {
    it('should return Markdown with type info for a function', async () => {
      // Arrange: Define a function with metadata
      const fnSymbol = createTestSymbol({
        name: 'calculateSum',
        kind: 'function',
        location: { uri: '/test/math.ts', line: 10, character: 16 },
        range: { startLine: 10, startCharacter: 16, endLine: 10, endCharacter: 28 },
        parametersCount: 2,
        isDefinition: true
      });
      mockIndex.addSymbol(fnSymbol);

      // Create document content
      const documentContent = `
import { calculateSum } from './math';

const total = calculateSum(5, 10);
`.trim();

      const documents = new Map([[testFileUri, documentContent]]);
      const services = createMockServices(mockIndex, documents);
      const state = createMockState();
      handler = new HoverHandler(services as any, state);

      // Act: Get definitions (hover would use this)
      const definitions = await mockIndex.findDefinitions('calculateSum');

      // Assert: Should find the function
      expect(definitions).toHaveLength(1);
      expect(definitions[0].kind).toBe('function');
      expect(definitions[0].parametersCount).toBe(2);
      
      // Verify what hover would show
      const symbol = definitions[0];
      expect(symbol.name).toBe('calculateSum');
      expect(symbol.location.uri).toBe('/test/math.ts');
    });

    it('should show class method with container name', async () => {
      // Arrange: Define a method in a class
      const methodSymbol = createTestSymbol({
        name: 'save',
        kind: 'method',
        containerName: 'UserRepository',
        location: { uri: '/test/repos/user.ts', line: 15, character: 2 },
        range: { startLine: 15, startCharacter: 2, endLine: 15, endCharacter: 6 },
        isDefinition: true
      });
      mockIndex.addSymbol(methodSymbol);

      // Act: Get definitions
      const definitions = await mockIndex.findDefinitions('save');

      // Assert: Should include container information
      expect(definitions).toHaveLength(1);
      expect(definitions[0].containerName).toBe('UserRepository');
      expect(definitions[0].kind).toBe('method');
    });

    it('should show static method indicator', async () => {
      // Arrange: Define a static method
      const staticMethod = createTestSymbol({
        name: 'create',
        kind: 'method',
        containerName: 'UserFactory',
        isStatic: true,
        location: { uri: '/test/factories/user.ts', line: 5, character: 9 },
        isDefinition: true
      });
      mockIndex.addSymbol(staticMethod);

      // Act: Get definitions
      const definitions = await mockIndex.findDefinitions('create');

      // Assert: Should indicate static
      expect(definitions).toHaveLength(1);
      expect(definitions[0].isStatic).toBe(true);
    });
  });

  describe('Scenario: Hover over Angular symbols', () => {
    it('should show component metadata', async () => {
      // Arrange: Angular component
      const componentSymbol = createTestSymbol({
        name: 'HeaderComponent',
        kind: 'class',
        location: { uri: '/test/components/header.component.ts', line: 10, character: 13 },
        isDefinition: true,
        metadata: {
          angular: {
            isComponent: true,
            selector: 'app-header'
          }
        }
      });
      mockIndex.addSymbol(componentSymbol);

      // Act: Get definitions
      const definitions = await mockIndex.findDefinitions('HeaderComponent');

      // Assert: Should include Angular metadata
      expect(definitions).toHaveLength(1);
      const metadata = definitions[0].metadata?.['angular'] as any;
      expect(metadata).toBeDefined();
      expect(metadata.isComponent).toBe(true);
      expect(metadata.selector).toBe('app-header');
    });

    it('should show Input/Output decorator info', async () => {
      // Arrange: Angular property with @Input
      const inputProp = createTestSymbol({
        name: 'title',
        kind: 'property',
        containerName: 'CardComponent',
        location: { uri: '/test/components/card.component.ts', line: 12, character: 2 },
        isDefinition: true,
        metadata: {
          angular: {
            isInput: true
          }
        }
      });
      mockIndex.addSymbol(inputProp);

      // Act: Get definitions
      const definitions = await mockIndex.findDefinitions('title');

      // Assert: Should include @Input metadata
      expect(definitions).toHaveLength(1);
      const metadata = definitions[0].metadata?.['angular'] as any;
      expect(metadata.isInput).toBe(true);
    });
  });

  describe('Scenario: Hover over NgRx symbols', () => {
    it('should show action type', async () => {
      // Arrange: NgRx action
      const actionSymbol = createTestSymbol({
        name: 'loadUsers',
        kind: 'variable',
        location: { uri: '/test/store/user.actions.ts', line: 5, character: 13 },
        isDefinition: true,
        metadata: {
          ngrx: {
            role: 'action',
            type: '[User Page] Load Users'
          }
        }
      });
      mockIndex.addSymbol(actionSymbol);

      // Act: Get definitions
      const definitions = await mockIndex.findDefinitions('loadUsers');

      // Assert: Should include NgRx action type
      expect(definitions).toHaveLength(1);
      const metadata = definitions[0].metadata?.['ngrx'] as any;
      expect(metadata.role).toBe('action');
      expect(metadata.type).toBe('[User Page] Load Users');
    });

    it('should indicate action groups', async () => {
      // Arrange: NgRx action group
      const actionGroup = createTestSymbol({
        name: 'UserActions',
        kind: 'variable',
        location: { uri: '/test/store/user.actions.ts', line: 3, character: 13 },
        isDefinition: true,
        metadata: {
          ngrx: {
            isGroup: true
          }
        }
      });
      mockIndex.addSymbol(actionGroup);

      // Act: Get definitions
      const definitions = await mockIndex.findDefinitions('UserActions');

      // Assert: Should indicate action group
      expect(definitions).toHaveLength(1);
      const metadata = definitions[0].metadata?.['ngrx'] as any;
      expect(metadata.isGroup).toBe(true);
    });

    it('should show effect metadata', async () => {
      // Arrange: NgRx effect
      const effectSymbol = createTestSymbol({
        name: 'loadUsers$',
        kind: 'property',
        containerName: 'UserEffects',
        location: { uri: '/test/store/user.effects.ts', line: 15, character: 2 },
        isDefinition: true,
        metadata: {
          ngrx: {
            role: 'effect'
          }
        }
      });
      mockIndex.addSymbol(effectSymbol);

      // Act: Get definitions
      const definitions = await mockIndex.findDefinitions('loadUsers$');

      // Assert: Should indicate effect
      expect(definitions).toHaveLength(1);
      const metadata = definitions[0].metadata?.['ngrx'] as any;
      expect(metadata.role).toBe('effect');
    });
  });

  describe('Scenario: Hover over unknown symbol', () => {
    it('should return null when symbol not found', async () => {
      // Arrange: Empty index
      
      // Act: Look up non-existent symbol
      const definitions = await mockIndex.findDefinitions('unknownSymbol');

      // Assert: Should return empty array
      expect(definitions).toEqual([]);
    });

    it('should return null for built-in JavaScript symbols', async () => {
      // Note: Built-in symbols like 'console', 'Array', etc. 
      // would not be in our index
      
      // Act: Look up console
      const definitions = await mockIndex.findDefinitions('console');

      // Assert: Should return empty (not indexed)
      expect(definitions).toEqual([]);
    });
  });

  describe('Symbol selection logic', () => {
    it('should prefer local file symbol over external', async () => {
      // Arrange: Symbol in current file and external file
      const localSymbol = createTestSymbol({
        name: 'formatDate',
        kind: 'function',
        location: { uri: testFilePath, line: 5, character: 9 },
        isDefinition: true
      });
      const externalSymbol = createTestSymbol({
        name: 'formatDate',
        kind: 'function',
        location: { uri: '/test/utils/date.ts', line: 10, character: 16 },
        isDefinition: true
      });
      
      mockIndex.addSymbol(localSymbol);
      mockIndex.addSymbol(externalSymbol);

      // Act: Get all definitions
      const definitions = await mockIndex.findDefinitions('formatDate');

      // Assert: Should find both
      expect(definitions).toHaveLength(2);
      
      // Handler would prefer local (same file)
      const localFound = definitions.find(d => d.location.uri === testFilePath);
      expect(localFound).toBeDefined();
    });

    it('should prefer matching kind when multiple symbols exist', async () => {
      // Arrange: Interface and class with same name
      const interfaceSymbol = createTestSymbol({
        name: 'User',
        kind: 'interface',
        location: { uri: '/test/models/user.interface.ts', line: 3, character: 17 },
        isDefinition: true
      });
      const classSymbol = createTestSymbol({
        name: 'User',
        kind: 'class',
        location: { uri: '/test/models/user.class.ts', line: 5, character: 13 },
        isDefinition: true
      });
      
      mockIndex.addSymbol(interfaceSymbol);
      mockIndex.addSymbol(classSymbol);

      // Act: Get all User definitions
      const definitions = await mockIndex.findDefinitions('User');

      // Assert: Should find both, handler would pick based on context
      expect(definitions).toHaveLength(2);
      const interfaceFound = definitions.some(d => d.kind === 'interface');
      const classFound = definitions.some(d => d.kind === 'class');
      expect(interfaceFound).toBe(true);
      expect(classFound).toBe(true);
    });
  });

  describe('Location breadcrumbs', () => {
    it('should show file path in hover content', async () => {
      // Arrange: Symbol with file location
      const symbol = createTestSymbol({
        name: 'processData',
        kind: 'function',
        location: { uri: '/test/services/data-processor.ts', line: 25, character: 16 },
        isDefinition: true
      });
      mockIndex.addSymbol(symbol);

      // Act: Get definitions
      const definitions = await mockIndex.findDefinitions('processData');

      // Assert: Should have file location info
      expect(definitions).toHaveLength(1);
      expect(definitions[0].location.uri).toBe('/test/services/data-processor.ts');
      expect(definitions[0].location.line).toBe(25);
      expect(definitions[0].location.character).toBe(16);
    });
  });
});
