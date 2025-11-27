// Test file to demonstrate the distinction between declarations and usages

// 1. Action definition (declaration - should be in definitions, NOT references)
export const createSigningStepStart = () => ({ type: 'CREATE_SIGNING_STEP_START' });

// 2. Facade class
export class SigningFacade {
  constructor(private store: any) {}

  // Method declaration (should NOT be indexed as a reference to the action)
  public createSigningStepStart() {
    // This IS a reference to the action (property access + call)
    this.store.dispatch(SigningActions.createSigningStepStart());
  }
  
  // Another method that uses the action
  public initializeSigning() {
    // This should also be counted as a reference
    const action = createSigningStepStart();
    this.store.dispatch(action);
  }
}

// 3. Actions namespace
export const SigningActions = {
  // Property declaration (should be in definitions)
  createSigningStepStart: () => ({ type: 'CREATE_SIGNING_STEP_START' }),
  
  // Another action
  completeSigningStep: () => ({ type: 'COMPLETE_SIGNING_STEP' })
};

// 4. Effect class
export class SigningEffects {
  // Reference to action in effect (should be indexed)
  initiateSigningEffect$ = this.actions$.pipe(
    ofType(SigningActions.createSigningStepStart)
  );
  
  constructor(private actions$: any) {}
}

// 5. Reducer
export function signingReducer(state: any, action: any) {
  switch (action.type) {
    // Reference in string literal - different case
    case 'CREATE_SIGNING_STEP_START':
      return { ...state, signing: true };
    default:
      return state;
  }
}

// 6. Direct usage
export function someUtility() {
  // This should be counted as a reference
  return createSigningStepStart();
}
