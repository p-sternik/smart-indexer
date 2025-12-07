import { IndexedSymbol } from '../types.js';

/**
 * Disambiguation heuristics for "Go to Definition" when multiple candidates exist.
 * 
 * Priority order:
 * 1. Same directory as call site
 * 2. Parent directory (one level up)
 * 3. Sibling directory (same parent)
 * 4. Source code over node_modules/dist/build
 * 5. Alphabetically by file path (deterministic)
 */
export function rankDefinitionCandidates(
  candidates: IndexedSymbol[],
  callSiteUri: string
): IndexedSymbol[] {
  if (candidates.length <= 1) {
    return candidates;
  }

  const callSiteDir = getDirectory(callSiteUri);
  const callSiteParentDir = getParentDirectory(callSiteDir);
  const isInNodeModules = (uri: string) => uri.includes('node_modules');
  const isInBuildFolder = (uri: string) => 
    uri.includes('/dist/') || uri.includes('\\dist\\') ||
    uri.includes('/out/') || uri.includes('\\out\\') ||
    uri.includes('/build/') || uri.includes('\\build\\');

  // Score each candidate
  const scored = candidates.map(candidate => {
    let score = 0;
    const candidateDir = getDirectory(candidate.location.uri);
    const candidateParentDir = getParentDirectory(candidateDir);

    // +100: Same directory (highest priority)
    if (candidateDir === callSiteDir) {
      score += 100;
    }

    // +70: Parent directory (one level up)
    if (candidateDir === callSiteParentDir) {
      score += 70;
    }

    // +50: Sibling directory (same parent)
    if (candidateParentDir === callSiteParentDir && candidateDir !== callSiteDir) {
      score += 50;
    }

    // +30: Within same package/folder hierarchy
    if (getCommonPathDepth(candidateDir, callSiteDir) >= 3) {
      score += 30;
    }

    // -80: node_modules penalty (strong penalty)
    if (isInNodeModules(candidate.location.uri)) {
      score -= 80;
    }

    // -40: build folder penalty
    if (isInBuildFolder(candidate.location.uri)) {
      score -= 40;
    }

    // +20: Same project (same root, not node_modules)
    if (!isInNodeModules(candidate.location.uri) && !isInBuildFolder(candidate.location.uri)) {
      score += 20;
    }

    // +10: Boost for src/ folder
    if (candidate.location.uri.includes('/src/') || candidate.location.uri.includes('\\src\\')) {
      score += 10;
    }

    return { candidate, score };
  });

  // Sort by score (descending), then by file path (alphabetically) for determinism
  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.candidate.location.uri.localeCompare(b.candidate.location.uri);
  });

  return scored.map(s => s.candidate);
}

function getDirectory(uri: string): string {
  const lastSlash = Math.max(uri.lastIndexOf('/'), uri.lastIndexOf('\\'));
  return lastSlash >= 0 ? uri.substring(0, lastSlash) : '';
}

function getParentDirectory(dir: string): string {
  const lastSlash = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
  return lastSlash >= 0 ? dir.substring(0, lastSlash) : '';
}

/**
 * Calculate the depth of common path between two directories.
 * Higher number means more closely related.
 */
function getCommonPathDepth(path1: string, path2: string): number {
  const parts1 = path1.split(/[/\\]/);
  const parts2 = path2.split(/[/\\]/);
  
  let depth = 0;
  for (let i = 0; i < Math.min(parts1.length, parts2.length); i++) {
    if (parts1[i] === parts2[i]) {
      depth++;
    } else {
      break;
    }
  }
  
  return depth;
}

/**
 * Filter and rank candidates based on multiple criteria.
 * Returns the best match if disambiguation is possible, otherwise returns all ranked candidates.
 */
export function disambiguateSymbols(
  candidates: IndexedSymbol[],
  callSiteUri: string,
  preferredContainer?: string
): IndexedSymbol[] {
  if (candidates.length === 0) {
    return [];
  }

  // First, filter by container if available
  let filtered = candidates;
  if (preferredContainer) {
    const containerMatches = candidates.filter(
      c => c.containerName === preferredContainer
    );
    if (containerMatches.length > 0) {
      filtered = containerMatches;
    }
  }

  // Apply ranking heuristics
  return rankDefinitionCandidates(filtered, callSiteUri);
}
