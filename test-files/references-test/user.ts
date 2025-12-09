// Definition file
export class User {
  constructor(public name: string, public email: string) {}

  getProfile() {
    return `${this.name} <${this.email}>`;
  }
}

export function createUser(name: string, email: string): User {
  return new User(name, email);
}

export const DEFAULT_USER = new User('Guest', 'guest@example.com');
