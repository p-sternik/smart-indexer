/**
 * Fuzzy search and ranking utilities for workspace symbols.
 * Implements scoring based on:
 * - Consecutive character matches
 * - CamelCase boundary matches
 * - Character position (earlier matches score higher)
 */

export interface FuzzyMatch {
  score: number;
  matches: number[]; // indices of matched characters
}

/**
 * Score a symbol name against a query string.
 * Returns null if no match, otherwise returns score and match positions.
 * 
 * Higher scores are better. Scoring factors:
 * - Consecutive matches: +15 per consecutive char after first
 * - CamelCase/acronym matches: +25 for uppercase boundary matches
 * - Start-of-word matches: +10 for matches after delimiters
 * - Position: +5 for earlier matches
 * - Case match: +2 for exact case match
 * - Prefix match: +50 bonus
 */
export function fuzzyScore(symbolName: string, query: string): FuzzyMatch | null {
  if (!query) {
    return { score: 0, matches: [] };
  }

  const lowerSymbol = symbolName.toLowerCase();
  const lowerQuery = query.toLowerCase();
  
  let score = 0;
  const matches: number[] = [];
  let symbolIndex = 0;
  let lastMatchIndex = -1;
  let consecutiveMatches = 0;

  for (let queryIndex = 0; queryIndex < lowerQuery.length; queryIndex++) {
    const queryChar = lowerQuery[queryIndex];
    let found = false;

    // Find next occurrence of query char in symbol
    for (; symbolIndex < lowerSymbol.length; symbolIndex++) {
      if (lowerSymbol[symbolIndex] === queryChar) {
        found = true;
        matches.push(symbolIndex);

        // Base score for match
        score += 10;

        // Bonus for consecutive matches (higher score)
        if (lastMatchIndex === symbolIndex - 1) {
          consecutiveMatches++;
          score += 15 * consecutiveMatches;
        } else {
          consecutiveMatches = 0;
        }

        // Bonus for CamelCase boundary match (acronym support)
        // e.g., "CFA" matching "CompatFieldAdapter"
        if (symbolIndex > 0 && isCamelCaseBoundary(symbolName, symbolIndex)) {
          score += 25; // Increased from 10 for better acronym matching
        }

        // Bonus for start-of-word match (after delimiter like _, -, etc.)
        if (symbolIndex > 0 && isWordBoundary(symbolName, symbolIndex)) {
          score += 10;
        }

        // Bonus for early position
        const positionBonus = Math.max(0, 5 * (1 - symbolIndex / symbolName.length));
        score += positionBonus;

        // Bonus for exact case match
        if (symbolName[symbolIndex] === query[queryIndex]) {
          score += 2;
        }

        lastMatchIndex = symbolIndex;
        symbolIndex++;
        break;
      }
    }

    if (!found) {
      return null; // Query char not found
    }
  }

  // Bonus for complete prefix match
  if (matches.length > 0 && matches[0] === 0 && matches.length === query.length) {
    let isPrefix = true;
    for (let i = 0; i < matches.length; i++) {
      if (matches[i] !== i) {
        isPrefix = false;
        break;
      }
    }
    if (isPrefix) {
      score += 50;
    }
  }

  return { score, matches };
}

/**
 * Check if a position is at a CamelCase boundary.
 */
function isCamelCaseBoundary(str: string, index: number): boolean {
  if (index === 0) {
    return true;
  }

  const current = str[index];
  const previous = str[index - 1];

  // Uppercase after lowercase (camelCase -> C is boundary)
  if (isUpperCase(current) && isLowerCase(previous)) {
    return true;
  }

  // Letter after non-letter (my_var -> v is boundary)
  if (isLetter(current) && !isLetter(previous)) {
    return true;
  }

  return false;
}

function isUpperCase(char: string): boolean {
  return char >= 'A' && char <= 'Z';
}

function isLowerCase(char: string): boolean {
  return char >= 'a' && char <= 'z';
}

function isLetter(char: string): boolean {
  return isUpperCase(char) || isLowerCase(char);
}

/**
 * Check if a position is at a word boundary (after delimiter).
 */
function isWordBoundary(str: string, index: number): boolean {
  if (index === 0) {
    return true;
  }

  const previous = str[index - 1];
  
  // After underscore, dash, dot, slash
  return previous === '_' || previous === '-' || previous === '.' || previous === '/' || previous === '\\';
}

/**
 * Rank symbols based on fuzzy score and context.
 * Priority factors:
 * 1. Fuzzy match score
 * 2. Open files (dynamic index)
 * 3. Source code over node_modules/dist
 * 4. Same directory as current file
 * 5. Definition priority (classes/interfaces over variables)
 */
export interface RankedSymbol<T> {
  symbol: T;
  score: number;
  matches: number[];
}

export interface RankingContext {
  currentFileUri?: string; // Current file for proximity ranking
  openFiles?: Set<string>; // URIs of open files
}

export function rankSymbols<T extends { name: string; location?: { uri: string } | string; kind?: string }>(
  symbols: T[],
  query: string,
  context?: RankingContext
): RankedSymbol<T>[] {
  const ranked: RankedSymbol<T>[] = [];

  for (const symbol of symbols) {
    const match = fuzzyScore(symbol.name, query);
    if (!match) {
      continue;
    }

    let score = match.score;
    const uri = typeof symbol.location === 'string' ? symbol.location : symbol.location?.uri;

    if (uri && context) {
      // Boost for open files
      if (context.openFiles?.has(uri)) {
        score += 100;
      }

      // Penalty for node_modules
      if (uri.includes('node_modules')) {
        score -= 50;
      }

      // Penalty for dist/out/build folders
      if (uri.includes('/dist/') || uri.includes('\\dist\\') ||
          uri.includes('/out/') || uri.includes('\\out\\') ||
          uri.includes('/build/') || uri.includes('\\build\\')) {
        score -= 30;
      }

      // Boost for same directory
      if (context.currentFileUri) {
        const currentDir = getDirectory(context.currentFileUri);
        const symbolDir = getDirectory(uri);
        if (currentDir === symbolDir) {
          score += 30;
        }
      }

      // Boost for src/ folder
      if (uri.includes('/src/') || uri.includes('\\src\\')) {
        score += 10;
      }
    }

    // Boost definition symbols (classes, interfaces) over internal variables
    if (symbol.kind) {
      if (symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'enum') {
        score += 15;
      } else if (symbol.kind === 'function') {
        score += 10;
      } else if (symbol.kind === 'variable' || symbol.kind === 'property') {
        score += 0; // No boost for variables/properties
      }
    }

    ranked.push({
      symbol,
      score,
      matches: match.matches
    });
  }

  // Sort by score descending, then by name alphabetically for deterministic order
  ranked.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.symbol.name.localeCompare(b.symbol.name);
  });

  return ranked;
}

function getDirectory(uri: string): string {
  const lastSlash = Math.max(uri.lastIndexOf('/'), uri.lastIndexOf('\\'));
  return lastSlash >= 0 ? uri.substring(0, lastSlash) : '';
}
