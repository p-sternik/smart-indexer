import { createAction, props } from '@ngrx/store';

// NgRx Actions - should enable loose mode
export const loadUsers = createAction(
  '[User] Load Users'
);

export const loadUsersSuccess = createAction(
  '[User] Load Users Success',
  props<{ users: any[] }>()
);

export const saveUser = createAction(
  '[User] Save User',
  props<{ user: any }>()
);

export const deleteUser = createAction(
  '[User] Delete User',
  props<{ id: string }>()
);
