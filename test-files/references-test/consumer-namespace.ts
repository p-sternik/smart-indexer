// Namespace import
import * as UserModule from './user';

const developer = new UserModule.User('Dev', 'dev@example.com');
const created = UserModule.createUser('Tester', 'test@example.com');

console.log(developer.getProfile());
console.log(created.getProfile());
