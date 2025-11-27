import { createActionGroup, emptyProps, props } from '@ngrx/store';

/**
 * Test file for createActionGroup support
 * 
 * This demonstrates the virtual symbol generation:
 * - 'Load Data' becomes loadData() method
 * - 'Clear Cache' becomes clearCache() method
 * - 'Update User' becomes updateUser() method
 */

export const PageActions = createActionGroup({
  source: 'Page',
  events: {
    'Load Data': emptyProps(),
    'Clear Cache': emptyProps(),
    'Update User': props<{ userId: string }>(),
  }
});

export const ApiActions = createActionGroup({
  source: 'API',
  events: {
    'Fetch Success': props<{ data: any }>(),
    'Fetch Error': props<{ error: string }>(),
  }
});

// Usage examples (these should now find the virtual symbols):
// PageActions.loadData()
// PageActions.clearCache()
// PageActions.updateUser({ userId: '123' })
// ApiActions.fetchSuccess({ data: {} })
// ApiActions.fetchError({ error: 'Failed' })
