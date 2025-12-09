// ESM import with rename
import { User as UserModel, createUser, DEFAULT_USER } from './user';

const admin = new UserModel('Admin', 'admin@example.com');
const guest = DEFAULT_USER;
const newUser = createUser('John', 'john@example.com');

console.log(admin.getProfile());
console.log(guest.getProfile());
console.log(newUser.getProfile());
