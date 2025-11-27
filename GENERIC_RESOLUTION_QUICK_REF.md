# Generic Symbol Resolution - Quick Reference

## What It Does
Enables "Go to Definition" (F12) to work through complex object chains and function calls.

## Examples

### Before (Didn't Work)
```typescript
const actions = createActionGroup({
  source: 'Page',
  events: { opened: emptyProps() }
});

actions.opened(); // F12 on "opened" → ❌ Nothing
```

### After (Works!)
```typescript
const actions = createActionGroup({
  source: 'Page',
  events: { opened: emptyProps() }  // ← Jumps here!
});

actions.opened(); // F12 on "opened" → ✅ Jumps to definition
```

## Supported Patterns

### 1. Object Literals
```typescript
const config = {
  apiKey: 'test',     // ← F12 on apiKey jumps here
  timeout: 5000
};

config.apiKey;
```

### 2. Nested Objects (Multi-level)
```typescript
const api = {
  v1: {
    users: {
      get: () => {}   // ← F12 on get jumps here
    }
  }
};

api.v1.users.get();
```

### 3. Function Return Values
```typescript
function createStore() {
  return {
    state: { count: 0 },
    actions: {
      increment: () => {}  // ← F12 on increment jumps here
    }
  };
}

const store = createStore();
store.actions.increment();
```

### 4. Framework Patterns (NgRx, Redux, etc.)
```typescript
const ProductActions = createActionGroup({
  source: 'Products',
  events: {
    opened: emptyProps(),        // ← F12 on opened jumps here
    selected: props<{ id: number }>()
  }
});

ProductActions.opened();
ProductActions.selected({ id: 1 });
```

### 5. Variable References
```typescript
const base = { value: 42 };  // ← F12 follows chain here
const ref = base;
ref.value;
```

## How to Use

1. **Write Code** with nested objects or function calls
2. **Place Cursor** on a property (e.g., the `opened` in `actions.opened`)
3. **Press F12** (or right-click → "Go to Definition")
4. **Jump** directly to the property definition

## Technical Details

- **Max Depth**: 10 levels of nesting
- **Performance**: ~5-50ms depending on complexity
- **Fallback**: Uses TypeScript service if AST analysis fails
- **Safety**: Circular reference detection prevents infinite loops

## Limitations

### Won't Work With:
1. **Computed Properties**
   ```typescript
   const key = 'dynamic';
   obj[key] // ❌ Cannot resolve
   ```

2. **Complex Conditionals**
   ```typescript
   function get() {
     if (Math.random() > 0.5) return { a: 1 };
     return { b: 2 };
   }
   // ⚠️ Only finds first return
   ```

3. **Advanced Destructuring**
   ```typescript
   const { nested: { prop } } = obj;
   prop // ⚠️ May not resolve
   ```

## Testing

Use the test file: `test-files/symbol-resolution-test.ts`

Contains 7 test cases covering all patterns above.

## Files Involved

- **Engine**: `server/src/indexer/recursiveResolver.ts`
- **Indexer**: `server/src/indexer/symbolIndexer.ts`
- **Handler**: `server/src/server.ts` (onDefinition)

## No Configuration Needed

Works automatically! Just:
1. Install/update the extension
2. Open a TypeScript/JavaScript file
3. Use "Go to Definition" as usual

## Troubleshooting

**Q: "Go to Definition" doesn't jump to nested property**

A: Check:
- Is the object a literal `{ }` or function return?
- Is nesting deeper than 10 levels?
- Try rebuilding index: `Cmd+Shift+P` → "Smart Indexer: Rebuild Index"

**Q: Performance seems slow**

A: 
- Recursive resolution takes 20-50ms for complex chains
- TypeScript fallback adds up to 200ms
- This is normal for deep analysis

**Q: Some properties resolve, others don't**

A:
- Dynamic properties (computed names) won't work
- Conditional returns may only find first path
- Check console for "[RecursiveResolver]" logs

## Architecture

```
User Action (F12)
    ↓
Parse Member Expression (e.g., "store.actions.get")
    ↓
Find Base Symbol ("store")
    ↓
Analyze Initializer
    ├─ Object Literal? → Find property directly
    ├─ Function Call? → Analyze return value
    └─ Identifier? → Follow reference chain
    ↓
Recurse for remaining chain ("actions.get")
    ↓
Return property location or fallback to TypeScript
```

## Benefits

✅ **No Framework Lock-in**: Works with any pattern  
✅ **Intelligent Navigation**: Understands code structure  
✅ **Fast**: Optimized for common cases  
✅ **Safe**: Depth-limited, circular-detection  
✅ **Backward Compatible**: Doesn't break existing features  

## Future Enhancements

- Cross-file function call tracing
- Caching of resolution results
- ML-based pattern learning
- Plugin system for custom patterns

---

**That's it!** The Generic Symbol Resolution Engine makes "Go to Definition" work through complex object structures automatically. Just use F12 as usual and enjoy smarter navigation! 🚀
