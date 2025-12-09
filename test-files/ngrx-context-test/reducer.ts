import { createReducer, on } from '@ngrx/store';
import { loadUsers, loadUsersSuccess, saveUser } from './actions';

export interface UserState {
  users: any[];
  loading: boolean;
}

const initialState: UserState = {
  users: [],
  loading: false
};

export const userReducer = createReducer(
  initialState,
  on(loadUsers, (state) => ({
    ...state,
    loading: true
  })),
  on(loadUsersSuccess, (state, { users }) => ({
    ...state,
    users,
    loading: false
  })),
  on(saveUser, (state, { user }) => ({
    ...state,
    users: [...state.users, user]
  }))
);
