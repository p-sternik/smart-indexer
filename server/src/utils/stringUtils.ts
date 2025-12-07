/**
 * String utilities for symbol name transformations
 */

import * as path from 'path';

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

/**
 * Sanitize a file path to handle Git's quoted/escaped output.
 * Handles:
 * - Surrounding double quotes: "path/to/file" -> path/to/file
 * - Embedded quotes (malformed paths): project\"projects -> projects (takes last valid segment)
 * - Octal escape sequences: \303\263 -> ó (UTF-8 decoding)
 * - Path normalization for cross-platform compatibility
 * 
 * @param filePath The potentially malformed file path
 * @returns A sanitized, normalized path
 */
export function sanitizeFilePath(filePath: string): string {
  let sanitized = filePath.trim();
  
  // Strip surrounding quotes if present (e.g., "path/to/file")
  if (sanitized.startsWith('"') && sanitized.endsWith('"')) {
    sanitized = sanitized.slice(1, -1);
  }
  
  // Handle embedded quotes (malformed Git output like: project\"projects\...)
  // This indicates Git's quoting was applied incorrectly or parsed wrong
  if (sanitized.includes('"')) {
    // Log for debugging
    // Remove all quotes - they shouldn't be in file paths
    sanitized = sanitized.replace(/"/g, '');
  }
  
  // Decode octal escape sequences if present (e.g., \303\263 -> ó)
  // This handles Git's core.quotePath=true output
  if (sanitized.includes('\\') && /\\[0-7]{3}/.test(sanitized)) {
    try {
      sanitized = sanitized.replace(/\\([0-7]{3})/g, (_, octal) => {
        return String.fromCharCode(parseInt(octal, 8));
      });
      // Handle UTF-8 byte sequences: convert bytes to proper UTF-8 string
      const bytes: number[] = [];
      for (let i = 0; i < sanitized.length; i++) {
        bytes.push(sanitized.charCodeAt(i));
      }
      sanitized = Buffer.from(bytes).toString('utf-8');
    } catch (error) {
      }
  }
  
  // Normalize path separators for cross-platform compatibility
  sanitized = path.normalize(sanitized);
  
  return sanitized;
}
