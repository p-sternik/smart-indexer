/**
 * Worker Angular Parsing Tests
 * 
 * Validates that processFileContent can parse Angular components
 * and extract symbols/metadata without running the full VS Code extension.
 */

import { describe, it, expect } from 'vitest';
import { processFileContent } from './worker.js';
import { IndexedSymbol } from '../types.js';

// Mock Angular component source code
const angularComponentSource = `
import { Component, Input, Output, EventEmitter } from '@angular/core';

@Component({
  selector: 'app-test-component',
  template: '<div>{{ title }}</div>'
})
export class TestComponent {
  @Input() title: string = '';
  @Input() count: number = 0;
  
  @Output() clicked = new EventEmitter<void>();
  @Output() valueChanged = new EventEmitter<string>();
  
  onClick(): void {
    this.clicked.emit();
  }
  
  onValueChange(value: string): void {
    this.valueChanged.emit(value);
  }
}
`;

function findSymbol(symbols: IndexedSymbol[], name: string): IndexedSymbol | undefined {
  return symbols.find(s => s.name === name);
}

describe('Worker Angular Parsing', () => {
  it('should parse file without skipping', async () => {
    const result = await processFileContent('test-uri.ts', angularComponentSource);
    expect(result.isSkipped).toBeFalsy();
  });

  it('should find TestComponent class', async () => {
    const result = await processFileContent('test-uri.ts', angularComponentSource);
    const componentSymbol = findSymbol(result.symbols, 'TestComponent');
    
    expect(componentSymbol).toBeDefined();
    expect(componentSymbol?.kind).toBe('class');
  });

  it('should extract Angular component metadata', async () => {
    const result = await processFileContent('test-uri.ts', angularComponentSource);
    const componentSymbol = findSymbol(result.symbols, 'TestComponent');
    
    const angularMeta = componentSymbol?.metadata?.['angular'] as Record<string, unknown> | undefined;
    expect(angularMeta?.['isComponent']).toBe(true);
    expect(angularMeta?.['decorator']).toBe('Component');
  });

  it('should find Input properties', async () => {
    const result = await processFileContent('test-uri.ts', angularComponentSource);
    
    const titleInput = findSymbol(result.symbols, 'title');
    const countInput = findSymbol(result.symbols, 'count');
    
    expect(titleInput).toBeDefined();
    expect(countInput).toBeDefined();
    expect(titleInput?.kind).toBe('property');
    expect(countInput?.kind).toBe('property');
  });

  it('should find Output properties', async () => {
    const result = await processFileContent('test-uri.ts', angularComponentSource);
    
    const clickedOutput = findSymbol(result.symbols, 'clicked');
    const valueChangedOutput = findSymbol(result.symbols, 'valueChanged');
    
    expect(clickedOutput).toBeDefined();
    expect(valueChangedOutput).toBeDefined();
    expect(clickedOutput?.kind).toBe('property');
    expect(valueChangedOutput?.kind).toBe('property');
  });

  it('should capture @angular/core imports', async () => {
    const result = await processFileContent('test-uri.ts', angularComponentSource);
    
    const angularImports = result.imports?.filter(imp => imp.moduleSpecifier === '@angular/core') || [];
    expect(angularImports.length).toBeGreaterThan(0);
    
    const importedNames = angularImports.map(imp => imp.localName);
    expect(importedNames).toContain('Component');
    expect(importedNames).toContain('Input');
    expect(importedNames).toContain('Output');
    expect(importedNames).toContain('EventEmitter');
  });

  it('should find class methods', async () => {
    const result = await processFileContent('test-uri.ts', angularComponentSource);
    
    const onClickMethod = findSymbol(result.symbols, 'onClick');
    const onValueChangeMethod = findSymbol(result.symbols, 'onValueChange');
    
    expect(onClickMethod).toBeDefined();
    expect(onValueChangeMethod).toBeDefined();
    expect(onClickMethod?.kind).toBe('method');
    expect(onValueChangeMethod?.kind).toBe('method');
  });

  it('should attach @Input metadata to properties', async () => {
    const result = await processFileContent('test-uri.ts', angularComponentSource);
    
    const titleInput = findSymbol(result.symbols, 'title');
    const angularMeta = titleInput?.metadata?.['angular'] as Record<string, unknown> | undefined;
    
    // After PropertyDefinition fix, Input decorator should be detected
    expect(angularMeta?.['isInput']).toBe(true);
  });

  it('should attach @Output metadata to properties', async () => {
    const result = await processFileContent('test-uri.ts', angularComponentSource);
    
    const clickedOutput = findSymbol(result.symbols, 'clicked');
    const angularMeta = clickedOutput?.metadata?.['angular'] as Record<string, unknown> | undefined;
    
    // After PropertyDefinition fix, Output decorator should be detected
    expect(angularMeta?.['isOutput']).toBe(true);
  });
});

describe('Worker with custom plugins', () => {
  it('should work with empty plugins array', async () => {
    const result = await processFileContent('test-uri.ts', angularComponentSource, []);
    
    // Should still parse symbols, just without framework metadata
    expect(result.isSkipped).toBeFalsy();
    expect(result.symbols.length).toBeGreaterThan(0);
    
    const componentSymbol = findSymbol(result.symbols, 'TestComponent');
    expect(componentSymbol).toBeDefined();
    // Without plugins, no Angular metadata should be attached
    expect(componentSymbol?.metadata?.['angular']).toBeUndefined();
  });
});
