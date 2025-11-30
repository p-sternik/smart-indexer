import { IShardPersistence, FileShard } from '../ShardPersistenceManager.js';
import { IndexedReference, PendingReference } from '../../types.js';
import { toCamelCase, toPascalCase } from '../../utils/stringUtils.js';

/**
 * NgRx Action Group entry discovered during scanning.
 */
interface ActionGroupEntry {
  uri: string;
  events: Record<string, string>;
}

/**
 * Represents an update to be applied to a shard's references.
 */
interface ShardUpdate {
  newRefs: IndexedReference[];
  resolvedKeys: Set<string>;
  ngrxCount: number;
  fallbackCount: number;
}

/**
 * Statistics from a resolution run.
 */
export interface NgRxResolutionStats {
  actionGroupsFound: number;
  totalPending: number;
  filesWithPending: number;
  ngrxResolved: number;
  fallbackResolved: number;
  shardsModified: number;
  durationMs: number;
}

/**
 * NgRxLinkResolver - Handles deferred resolution of NgRx action group references.
 * 
 * NgRx's `createActionGroup` creates virtual action symbols at runtime that can't be
 * resolved during single-file parsing. This service:
 * 
 * 1. Scans all shards to build a lookup of action groups and their events
 * 2. Resolves pending references (e.g., `PageActions.load()`) to actual action symbols
 * 3. Updates shards with resolved references in batch
 * 
 * This is extracted from BackgroundIndex to adhere to Single Responsibility Principle.
 */
export class NgRxLinkResolver {
  private shardManager: IShardPersistence;
  private lastStats: NgRxResolutionStats | null = null;

  constructor(shardManager: IShardPersistence) {
    this.shardManager = shardManager;
  }

  /**
   * Resolve all pending NgRx references across the workspace.
   * 
   * @param fileUris - List of all indexed file URIs to scan
   * @param loadShard - Function to load a shard by URI (uses BackgroundIndex's cache)
   * @param referenceMap - In-memory reference map to update (symbolName -> Set<URI>)
   * @returns Statistics about the resolution process
   */
  async resolveAll(
    fileUris: string[],
    loadShard: (uri: string) => Promise<FileShard | null>,
    referenceMap: Map<string, Set<string>>
  ): Promise<NgRxResolutionStats> {
    const startTime = Date.now();
    
    console.info('[NgRxLinkResolver] Starting resolution phase...');
    
    // STEP 1: Single pass to build NgRx lookup AND collect pending references
    console.info('[NgRxLinkResolver] Step 1: Scanning files for action groups and pending refs...');
    
    const actionGroupLookup = new Map<string, ActionGroupEntry>();
    const pendingByFile = new Map<string, PendingReference[]>();
    
    const totalFiles = fileUris.length;
    let symbolsScanned = 0;
    let totalPending = 0;
    
    for (let i = 0; i < fileUris.length; i++) {
      const uri = fileUris[i];
      if (i % 100 === 0) {
        console.info(`[NgRxLinkResolver] Step 1 progress: ${i}/${totalFiles} files scanned`);
      }
      
      const shard = await loadShard(uri);
      if (!shard) {
        continue;
      }
      
      // Collect NgRx action groups
      for (const symbol of shard.symbols) {
        symbolsScanned++;
        if (symbol.ngrxMetadata?.isGroup === true && symbol.ngrxMetadata?.events) {
          actionGroupLookup.set(symbol.name, {
            uri,
            events: symbol.ngrxMetadata.events
          });
        }
      }
      
      // Collect pending references
      if (shard.pendingReferences && shard.pendingReferences.length > 0) {
        pendingByFile.set(uri, [...shard.pendingReferences]);
        totalPending += shard.pendingReferences.length;
      }
    }
    
    console.info(
      `[NgRxLinkResolver] Step 1 complete: Found ${actionGroupLookup.size} action groups, ` +
      `${totalPending} pending refs in ${pendingByFile.size} files ` +
      `(scanned ${symbolsScanned} symbols in ${totalFiles} files)`
    );
    
    if (totalPending === 0) {
      console.info(`[NgRxLinkResolver] No pending references to resolve. Done.`);
      this.lastStats = {
        actionGroupsFound: actionGroupLookup.size,
        totalPending: 0,
        filesWithPending: 0,
        ngrxResolved: 0,
        fallbackResolved: 0,
        shardsModified: 0,
        durationMs: Date.now() - startTime
      };
      return this.lastStats;
    }
    
    // STEP 2: Resolve all references in-memory (no I/O)
    console.info('[NgRxLinkResolver] Step 2: Resolving references in-memory...');
    
    const updatesByFile = new Map<string, ShardUpdate>();
    let ngrxResolved = 0;
    let fallbackResolved = 0;
    
    for (const [uri, pendingRefs] of pendingByFile) {
      const update: ShardUpdate = {
        newRefs: [],
        resolvedKeys: new Set(),
        ngrxCount: 0,
        fallbackCount: 0
      };
      
      for (const pending of pendingRefs) {
        const pendingKey = `${pending.container}:${pending.member}:${pending.location.line}:${pending.location.character}`;
        
        // Try NgRx resolution first
        const actionGroup = actionGroupLookup.get(pending.container);
        let resolvedAsNgRx = false;
        
        if (actionGroup) {
          // Check if the member exists in the events map
          let matchedMember: string | null = null;
          
          if (pending.member in actionGroup.events) {
            matchedMember = pending.member;
          } else {
            const camelMember = toCamelCase(pending.member);
            if (camelMember in actionGroup.events) {
              matchedMember = camelMember;
            } else {
              const pascalMember = toPascalCase(pending.member);
              if (pascalMember in actionGroup.events) {
                matchedMember = pascalMember;
              }
            }
          }
          
          if (matchedMember) {
            update.newRefs.push({
              symbolName: pending.member,
              location: pending.location,
              range: pending.range,
              containerName: pending.containerName,
              isLocal: false
            });
            update.resolvedKeys.add(pendingKey);
            update.ngrxCount++;
            resolvedAsNgRx = true;
            
            // Update in-memory referenceMap
            let refUriSet = referenceMap.get(pending.member);
            if (!refUriSet) {
              refUriSet = new Set();
              referenceMap.set(pending.member, refUriSet);
            }
            refUriSet.add(uri);
          }
        }
        
        // Fallback: Non-NgRx imported member access
        if (!resolvedAsNgRx) {
          const qualifiedName = `${pending.container}.${pending.member}`;
          update.newRefs.push({
            symbolName: qualifiedName,
            location: pending.location,
            range: pending.range,
            containerName: pending.containerName,
            isLocal: false
          });
          update.resolvedKeys.add(pendingKey);
          update.fallbackCount++;
          
          // Update in-memory referenceMap
          let refUriSet = referenceMap.get(qualifiedName);
          if (!refUriSet) {
            refUriSet = new Set();
            referenceMap.set(qualifiedName, refUriSet);
          }
          refUriSet.add(uri);
        }
      }
      
      if (update.newRefs.length > 0) {
        updatesByFile.set(uri, update);
        ngrxResolved += update.ngrxCount;
        fallbackResolved += update.fallbackCount;
      }
    }
    
    console.info(
      `[NgRxLinkResolver] Step 2 complete: Resolved ${ngrxResolved} NgRx + ${fallbackResolved} fallback refs in-memory`
    );
    
    // STEP 3: Batch write - single load + save per file
    console.info('[NgRxLinkResolver] Step 3: Batch writing updates to disk...');
    
    let shardsModified = 0;
    const totalUpdates = updatesByFile.size;
    let processedCount = 0;
    
    for (const [uri, update] of updatesByFile) {
      processedCount++;
      
      console.info(`[NgRxLinkResolver] Step 3 processing ${processedCount}/${totalUpdates}: ${uri}`);
      
      try {
        // Use Promise.race with timeout to prevent infinite hangs
        const timeoutMs = 5000;
        const result = await Promise.race([
          this.shardManager.withLock(uri, async () => {
            // CRITICAL: Use loadShardNoLock to avoid nested lock acquisition
            const shard = await this.shardManager.loadShardNoLock(uri);
            if (!shard) {
              console.warn(`[NgRxLinkResolver] Step 3: Shard not found for ${uri}`);
              return false;
            }
            
            // Ensure arrays exist
            shard.references = shard.references || [];
            
            // Build set of existing ref keys for deduplication
            const existingRefKeys = new Set(
              shard.references.map(r => `${r.symbolName}:${r.location.line}:${r.location.character}`)
            );
            
            // Add only new references (avoid duplicates)
            for (const newRef of update.newRefs) {
              const refKey = `${newRef.symbolName}:${newRef.location.line}:${newRef.location.character}`;
              if (!existingRefKeys.has(refKey)) {
                shard.references.push(newRef);
                existingRefKeys.add(refKey);
              }
            }
            
            // Remove resolved pending references
            if (shard.pendingReferences) {
              shard.pendingReferences = shard.pendingReferences.filter(pr => {
                const key = `${pr.container}:${pr.member}:${pr.location.line}:${pr.location.character}`;
                return !update.resolvedKeys.has(key);
              });
            }
            
            // CRITICAL: Use saveShardNoLock to avoid nested lock
            await this.shardManager.saveShardNoLock(shard);
            return true;
          }),
          new Promise<boolean>((_, reject) => 
            setTimeout(() => reject(new Error(`TIMEOUT after ${timeoutMs}ms`)), timeoutMs)
          )
        ]);
        
        if (result) {
          shardsModified++;
        }
        console.info(`[NgRxLinkResolver] Step 3 done ${processedCount}/${totalUpdates}: ${uri}`);
      } catch (error) {
        console.error(`[NgRxLinkResolver] Step 3 FAILED for ${uri}: ${error}`);
        // Continue processing other files even if one fails
      }
    }
    
    const duration = Date.now() - startTime;
    console.info(
      `[NgRxLinkResolver] Complete: ` +
      `NgRx=${ngrxResolved}, Fallback=${fallbackResolved}, Total=${totalPending} ` +
      `(${shardsModified} shards modified) in ${duration}ms`
    );
    
    this.lastStats = {
      actionGroupsFound: actionGroupLookup.size,
      totalPending,
      filesWithPending: pendingByFile.size,
      ngrxResolved,
      fallbackResolved,
      shardsModified,
      durationMs: duration
    };
    
    return this.lastStats;
  }

  /**
   * Get a formatted statistics string for logging.
   */
  getStats(): string {
    if (!this.lastStats) {
      return 'NgRxLinkResolver: No resolution run yet';
    }
    
    const s = this.lastStats;
    return `NgRxLinkResolver: ${s.actionGroupsFound} action groups, ` +
      `${s.ngrxResolved}/${s.totalPending} NgRx resolved, ` +
      `${s.fallbackResolved} fallback, ` +
      `${s.shardsModified} shards modified in ${s.durationMs}ms`;
  }
}
