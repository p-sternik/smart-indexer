// Test file for fuzzy search improvements
// Test acronym matching: "CFA" should find "CompatFieldAdapter"

export class CompatFieldAdapter {
  constructor() {}
  
  adaptField(field: string): string {
    return field;
  }
}

export class CompactFileArchiver {
  archive(): void {}
}

export class ComponentFormActivator {
  activate(): void {}
}

export class CustomFieldAccessor {
  access(): void {}
}

// Test camelCase matching: "newRoot" should find all these
export function newRootElement() {
  return document.createElement('div');
}

export function createNewRootNode() {
  return { type: 'root' };
}

export const newRootConfig = {
  enabled: true
};

// Test word boundary matching
export function parse_user_input() {}
export function format-file-name() {}

// Test regular names
export class UserService {}
export class DataRepository {}
export function calculateTotal() {}
