// NOT an NgRx file - should use strict mode
class CustomDispatcher {
  dispatch(action: any) {
    console.log(action);
  }
}

// This "loadData" should NOT trigger loose mode (no @ngrx import)
export const loadData = () => {
  return { type: 'LOAD_DATA' };
};

export const saveRecord = () => {
  return { type: 'SAVE_RECORD' };
};
