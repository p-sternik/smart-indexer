/**
 * String utilities for symbol name transformations
 */

/**
 * Convert a string to camelCase
 * Examples:
 *   'Load Data' -> 'loadData'
 *   'Load' -> 'load'
 *   'load-data' -> 'loadData'
 *   'LOAD_DATA' -> 'loadData'
 */
export function toCamelCase(str: string): string {
  // Handle empty strings
  if (!str) {
    return '';
  }

  // Split by spaces, hyphens, underscores, or camelCase boundaries
  const words = str
    .replace(/([a-z])([A-Z])/g, '$1 $2') // Split camelCase
    .replace(/[_-]/g, ' ') // Replace _ and - with spaces
    .split(/\s+/) // Split by whitespace
    .filter(word => word.length > 0); // Remove empty strings

  if (words.length === 0) {
    return '';
  }

  // First word is lowercase, rest are capitalized
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index === 0) {
        return lower;
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join('');
}

/**
 * Convert a string to PascalCase
 * Examples:
 *   'Load Data' -> 'LoadData'
 *   'load-data' -> 'LoadData'
 */
export function toPascalCase(str: string): string {
  const camel = toCamelCase(str);
  if (!camel) {
    return '';
  }
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

/**
 * Convert a string to kebab-case
 * Examples:
 *   'LoadData' -> 'load-data'
 *   'Load Data' -> 'load-data'
 */
export function toKebabCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/\s+/g, '-')
    .replace(/_/g, '-')
    .toLowerCase();
}

/**
 * Convert a string to snake_case
 * Examples:
 *   'LoadData' -> 'load_data'
 *   'Load Data' -> 'load_data'
 */
export function toSnakeCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/\s+/g, '_')
    .replace(/-/g, '_')
    .toLowerCase();
}
