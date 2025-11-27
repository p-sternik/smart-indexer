// Test file for Generic Symbol Resolution Engine

// Test Case 1: Simple object literal
export const simpleConfig = {
  apiKey: 'test-key',
  endpoint: '/api/v1',
  timeout: 5000
};

// Usage: simpleConfig.apiKey should jump to line 5

// Test Case 2: Nested object literal
export const nestedApi = {
  v1: {
    users: {
      get: () => fetch('/users'),
      post: (data: any) => fetch('/users', { method: 'POST', body: JSON.stringify(data) })
    },
    products: {
      list: () => fetch('/products'),
      create: (data: any) => fetch('/products', { method: 'POST', body: JSON.stringify(data) })
    }
  }
};

// Usage: nestedApi.v1.users.get should jump to line 14
// Usage: nestedApi.v1.products.create should jump to line 19

// Test Case 3: Function that returns an object
function createStore() {
  return {
    state: { count: 0 },
    actions: {
      increment: () => console.log('increment'),
      decrement: () => console.log('decrement'),
      reset: () => console.log('reset')
    }
  };
}

export const myStore = createStore();

// Usage: myStore.actions.increment should jump to line 31
// Usage: myStore.state should jump to line 30

// Test Case 4: Framework pattern (NgRx-like)
interface ActionGroup {
  source: string;
  events: Record<string, any>;
}

function createActionGroup(config: ActionGroup) {
  // In real NgRx, this would generate action creators
  // For our test, we'll return a simple object
  return config.events;
}

export const ProductsPageActions = createActionGroup({
  source: 'Products Page',
  events: {
    opened: () => ({ type: '[Products Page] Opened' }),
    closed: () => ({ type: '[Products Page] Closed' }),
    productSelected: (productId: number) => ({ 
      type: '[Products Page] Product Selected', 
      productId 
    })
  }
});

// Usage: ProductsPageActions.opened should jump to line 58
// Usage: ProductsPageActions.productSelected should jump to line 60

// Test Case 5: Chained variable references
const baseConfig = {
  production: false,
  apiUrl: 'http://localhost:3000'
};

export const appConfig = baseConfig;

// Usage: appConfig.production should resolve through chain to line 73

// Test Case 6: Deep nesting
export const deeplyNested = {
  level1: {
    level2: {
      level3: {
        level4: {
          level5: {
            finalValue: 'You found me!'
          }
        }
      }
    }
  }
};

// Usage: deeplyNested.level1.level2.level3.level4.level5.finalValue should jump to line 87

// Test Case 7: Mixed patterns
function createApiClient(baseUrl: string) {
  return {
    users: {
      getById: (id: number) => fetch(`${baseUrl}/users/${id}`),
      getAll: () => fetch(`${baseUrl}/users`)
    }
  };
}

export const apiClient = createApiClient('https://api.example.com');

// Usage: apiClient.users.getById should jump to line 103

console.log('Generic Symbol Resolution Test Suite Loaded');
console.log('Try Go to Definition on various property accesses above!');
