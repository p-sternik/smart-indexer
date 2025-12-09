/**
 * Example NgRx createActionGroup usage for manual testing
 * This demonstrates the virtual symbols that will be indexed
 */

import { createActionGroup, props, emptyProps } from '@ngrx/store';

// Example 1: User Actions
export const UserActions = createActionGroup({
  source: 'User',
  events: {
    'Load User': props<{ id: string }>(),
    'Update User': props<{ id: string; name: string }>(),
    'Delete User': props<{ id: string }>(),
    'Log Out': emptyProps()
  }
});

// Example 2: Signing Actions (from task description)
export const SigningActions = createActionGroup({
  source: 'Signing',
  events: {
    'Update Signing Action': props<{ action: string }>(),
    'Complete Signing': emptyProps()
  }
});

// Example 3: Edge cases
export const EdgeCaseActions = createActionGroup({
  source: 'EdgeCase',
  events: {
    // Single word
    'simple': emptyProps(),
    
    // Already camelCase
    'AlreadyCamel': emptyProps(),
    
    // Underscores
    'load_user_data': props<{ data: any }>(),
    
    // Dashes
    'save-user-data': props<{ data: any }>(),
    
    // Mixed
    'Update Signing Action': props<{ action: string }>()
  }
});

// Example 4: Identifier keys (not string literals)
export const IdentifierActions = createActionGroup({
  source: 'Identifier',
  events: {
    loadData: props<{ url: string }>(),
    saveData: props<{ data: any }>()
  }
});

/**
 * Expected indexed virtual symbols:
 * 
 * UserActions:
 *   - loadUser (method) -> 'Load User'
 *   - updateUser (method) -> 'Update User'
 *   - deleteUser (method) -> 'Delete User'
 *   - logOut (method) -> 'Log Out'
 * 
 * SigningActions:
 *   - updateSigningAction (method) -> 'Update Signing Action'
 *   - completeSigning (method) -> 'Complete Signing'
 * 
 * EdgeCaseActions:
 *   - simple (method) -> 'simple'
 *   - alreadyCamel (method) -> 'AlreadyCamel'
 *   - loadUserData (method) -> 'load_user_data'
 *   - saveUserData (method) -> 'save-user-data'
 *   - updateSigningAction (method) -> 'Update Signing Action'
 * 
 * IdentifierActions:
 *   - loadData (method) -> 'loadData'
 *   - saveData (method) -> 'saveData'
 */

// Usage examples (what users will actually type):
const user = { id: '123', name: 'John' };

// These methods are generated at runtime by NgRx
store.dispatch(UserActions.loadUser({ id: '123' }));
store.dispatch(UserActions.updateUser({ id: '123', name: 'Jane' }));
store.dispatch(UserActions.logOut());

store.dispatch(SigningActions.updateSigningAction({ action: 'sign' }));

store.dispatch(EdgeCaseActions.simple());
store.dispatch(EdgeCaseActions.alreadyCamel());
store.dispatch(EdgeCaseActions.loadUserData({ data: {} }));
