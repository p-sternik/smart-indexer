// NgRx Pattern Recognition Test File
// This file demonstrates the Smart Indexer's ability to recognize and link NgRx patterns

// ============================================================================
// MODERN NGRX: createAction
// ============================================================================

// Action Creator using modern createAction
export const loadProducts = createAction(
  '[Products Page] Load Products'
);

export const loadProductsSuccess = createAction(
  '[Products API] Load Products Success',
  props<{ products: any[] }>()
);

export const loadProductsFailure = createAction(
  '[Products API] Load Products Failure',
  props<{ error: string }>()
);

export const selectProduct = createAction(
  '[Products Page] Select Product',
  props<{ productId: number }>()
);

// ============================================================================
// MODERN NGRX: Effects (createEffect)
// ============================================================================

export class ProductsEffects {
  // Modern effect with createEffect
  loadProducts$ = createEffect(() =>
    this.actions$.pipe(
      ofType(loadProducts),  // Reference to action - should link to line 9
      switchMap(() =>
        this.productsService.getAll().pipe(
          map(products => loadProductsSuccess({ products })),
          catchError(error => of(loadProductsFailure({ error: error.message })))
        )
      )
    )
  );

  // Effect handling product selection
  selectProduct$ = createEffect(() =>
    this.actions$.pipe(
      ofType(selectProduct),  // Reference to action - should link to line 22
      tap(action => console.log('Selected product:', action.productId))
    ),
    { dispatch: false }
  );

  constructor(
    private actions$: any,
    private productsService: any
  ) {}
}

// ============================================================================
// MODERN NGRX: Reducers (on function)
// ============================================================================

export interface ProductsState {
  products: any[];
  selectedProductId: number | null;
  loading: boolean;
  error: string | null;
}

export const initialState: ProductsState = {
  products: [],
  selectedProductId: null,
  loading: false,
  error: null
};

export const productsReducer = createReducer(
  initialState,
  // on() references - should link to action creators
  on(loadProducts, state => ({
    ...state,
    loading: true,
    error: null
  })),
  on(loadProductsSuccess, (state, { products }) => ({
    ...state,
    products,
    loading: false
  })),
  on(loadProductsFailure, (state, { error }) => ({
    ...state,
    error,
    loading: false
  })),
  on(selectProduct, (state, { productId }) => ({
    ...state,
    selectedProductId: productId
  }))
);

// ============================================================================
// LEGACY NGRX: Action Classes with Action Interface
// ============================================================================

// Legacy action enum
export enum UserActionTypes {
  LoadUsers = '[Users Page] Load Users',
  LoadUsersSuccess = '[Users API] Load Users Success',
  LoadUsersFailure = '[Users API] Load Users Failure'
}

// Legacy action class implementing Action interface
export class LoadUsers implements Action {
  readonly type = UserActionTypes.LoadUsers;
}

export class LoadUsersSuccess implements Action {
  readonly type = UserActionTypes.LoadUsersSuccess;
  constructor(public payload: { users: any[] }) {}
}

export class LoadUsersFailure implements Action {
  readonly type = UserActionTypes.LoadUsersFailure;
  constructor(public payload: { error: string }) {}
}

// Union type for all user actions
export type UserActions = LoadUsers | LoadUsersSuccess | LoadUsersFailure;

// ============================================================================
// LEGACY NGRX: Effects with @Effect decorator
// ============================================================================

export class UserEffects {
  // Legacy effect with @Effect decorator
  @Effect()
  loadUsers$ = this.actions$.pipe(
    ofType(UserActionTypes.LoadUsers),  // String-based ofType
    switchMap(() =>
      this.userService.getAll().pipe(
        map(users => new LoadUsersSuccess({ users })),
        catchError(error => of(new LoadUsersFailure({ error: error.message })))
      )
    )
  );

  constructor(
    private actions$: any,
    private userService: any
  ) {}
}

// ============================================================================
// LEGACY NGRX: Switch-based Reducer
// ============================================================================

export interface UsersState {
  users: any[];
  loading: boolean;
  error: string | null;
}

export const initialUsersState: UsersState = {
  users: [],
  loading: false,
  error: null
};

export function usersReducer(
  state = initialUsersState,
  action: UserActions
): UsersState {
  switch (action.type) {
    case UserActionTypes.LoadUsers:
      return {
        ...state,
        loading: true,
        error: null
      };
    
    case UserActionTypes.LoadUsersSuccess:
      return {
        ...state,
        users: action.payload.users,
        loading: false
      };
    
    case UserActionTypes.LoadUsersFailure:
      return {
        ...state,
        error: action.payload.error,
        loading: false
      };
    
    default:
      return state;
  }
}

// ============================================================================
// MIXED PATTERNS: Namespace-based Actions
// ============================================================================

export const SigningActions = {
  // Action creators in object literal
  createSigningStepStart: () => ({ type: '[Signing] Create Step Start' as const }),
  createSigningStepSuccess: () => ({ type: '[Signing] Create Step Success' as const }),
  createSigningStepFailure: (error: string) => ({ type: '[Signing] Create Step Failure' as const, error })
};

// Effect using namespace actions
export class SigningEffects {
  initiateSigningEffect$ = this.actions$.pipe(
    ofType(SigningActions.createSigningStepStart)  // Should link to line 219
  );
  
  constructor(private actions$: any) {}
}

// ============================================================================
// FACADE PATTERN: Dispatching Actions
// ============================================================================

export class ProductsFacade {
  constructor(private store: any) {}

  // Dispatching modern actions
  loadProducts(): void {
    this.store.dispatch(loadProducts());  // Reference to action - should link to line 9
  }

  selectProduct(productId: number): void {
    this.store.dispatch(selectProduct({ productId }));  // Reference - should link to line 22
  }

  // Dispatching legacy actions
  loadUsers(): void {
    this.store.dispatch(new LoadUsers());  // Reference - should link to class
  }

  // Dispatching namespace actions
  startSigning(): void {
    this.store.dispatch(SigningActions.createSigningStepStart());  // Should link to line 219
  }
}

// ============================================================================
// EXPECTED BEHAVIOR SUMMARY
// ============================================================================
// 
// 1. MODERN ACTIONS (createAction):
//    - "Go to Definition" on loadProducts in ofType() → jumps to line 9
//    - "Go to Definition" on loadProducts in on() → jumps to line 9
//    - "Go to Definition" on loadProducts in dispatch() → jumps to line 9
//    - Symbol should have ngrxMetadata: { type: '[Products Page] Load Products', role: 'action' }
//
// 2. MODERN EFFECTS (createEffect):
//    - loadProducts$ should be indexed with ngrxMetadata: { type: 'loadProducts$', role: 'effect' }
//    - selectProduct$ should be indexed with ngrxMetadata: { type: 'selectProduct$', role: 'effect' }
//
// 3. LEGACY ACTIONS (Class implements Action):
//    - LoadUsers class should have ngrxMetadata: { type: 'LoadUsers', role: 'action' }
//    - LoadUsersSuccess class should have ngrxMetadata: { type: 'LoadUsersSuccess', role: 'action' }
//
// 4. LEGACY EFFECTS (@Effect decorator):
//    - loadUsers$ should be indexed with ngrxMetadata: { type: 'loadUsers$', role: 'effect' }
//
// 5. REFERENCES:
//    - ofType(loadProducts) → creates reference to loadProducts symbol
//    - on(loadProducts, ...) → creates reference to loadProducts symbol
//    - SigningActions.createSigningStepStart → creates reference to createSigningStepStart property
//
// ============================================================================

console.log('NgRx Pattern Recognition Test File Loaded');
console.log('Try "Go to Definition" on various action references!');

// Placeholder imports (not real NgRx)
function createAction(type: string, config?: any): any { return null; }
function props<T>(): any { return null; }
function createEffect(fn: any, config?: any): any { return null; }
function createReducer(...args: any[]): any { return null; }
function on(...args: any[]): any { return null; }
function ofType(...args: any[]): any { return null; }
function switchMap(fn: any): any { return null; }
function map(fn: any): any { return null; }
function catchError(fn: any): any { return null; }
function tap(fn: any): any { return null; }
function of(...args: any[]): any { return null; }
interface Action { type: string; }
function Effect(): any { return null; }
