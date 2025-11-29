/**
 * Text utilities for LSP handlers.
 * 
 * Provides optimized text processing functions shared across handlers.
 */

/**
 * Get word range at a given offset in text.
 * 
 * OPTIMIZED: Scans outward from offset in O(word_length) time,
 * instead of scanning from document start in O(document_length).
 * 
 * @param text - The document text
 * @param offset - Cursor position offset
 * @returns Word range or null if no word at position
 */
export function getWordRangeAtPosition(
  text: string,
  offset: number
): { start: number; end: number } | null {
  if (offset < 0 || offset > text.length) {
    return null;
  }

  // Check if we're at a valid identifier character
  const isIdentifierChar = (char: string): boolean => /[a-zA-Z0-9_]/.test(char);

  // If offset is at end of text or not on an identifier char, check character before
  let checkOffset = offset;
  if (offset === text.length || !isIdentifierChar(text[offset])) {
    // Try the character just before the cursor
    if (offset > 0 && isIdentifierChar(text[offset - 1])) {
      checkOffset = offset - 1;
    } else {
      return null;
    }
  }

  // Scan backwards to find start of word
  let start = checkOffset;
  while (start > 0 && isIdentifierChar(text[start - 1])) {
    start--;
  }

  // Scan forwards to find end of word
  let end = checkOffset;
  while (end < text.length && isIdentifierChar(text[end])) {
    end++;
  }

  // Ensure we have a valid identifier (must start with letter or underscore)
  if (start === end || !/[a-zA-Z_]/.test(text[start])) {
    return null;
  }

  return { start, end };
}

/**
 * Extract the word at a given offset in text.
 * 
 * @param text - The document text
 * @param offset - Cursor position offset
 * @returns The word at the position or null
 */
export function getWordAtPosition(text: string, offset: number): string | null {
  const range = getWordRangeAtPosition(text, offset);
  if (!range) {
    return null;
  }
  return text.substring(range.start, range.end);
}
