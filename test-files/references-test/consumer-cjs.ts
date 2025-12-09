// CommonJS require with rename
const { User: UserClass, createUser } = require('./user');

const manager = new UserClass('Manager', 'manager@example.com');
const user = createUser('Jane', 'jane@example.com');

console.log(manager.getProfile());
console.log(user.getProfile());
