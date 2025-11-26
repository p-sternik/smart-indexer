// Test file for symbol disambiguation
// This file contains two classes with methods named "newRoot"

class CompatFieldAdapter {
  // Instance method
  newRoot(fieldName: string): any {
    return { field: fieldName };
  }

  // Another method
  adapt(data: any): void {
    const root = this.newRoot('test');
    console.log(root);
  }
}

class FieldPathNode {
  // Static method with same name but different class
  static newRoot(): FieldPathNode {
    return new FieldPathNode();
  }

  // Instance method
  getValue(): string {
    return 'value';
  }

  // Usage of static method
  static createDefault(): FieldPathNode {
    return FieldPathNode.newRoot();
  }
}

// Test usage
const adapter = new CompatFieldAdapter();
adapter.newRoot('myField'); // Should resolve to CompatFieldAdapter.newRoot

const node = FieldPathNode.newRoot(); // Should resolve to FieldPathNode.newRoot
const node2 = FieldPathNode.createDefault();

// Another class with a different newRoot method
class TreeNode {
  static newRoot(value: number): TreeNode {
    return new TreeNode(value);
  }

  constructor(private value: number) {}

  getValue(): number {
    return this.value;
  }
}

const tree = TreeNode.newRoot(42); // Should resolve to TreeNode.newRoot
