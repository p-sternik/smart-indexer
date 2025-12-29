import { IIndexStorage } from '../../storage/IIndexStorage.js';
import { IndexedReference } from '../../types.js';
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
  private storage: IIndexStorage;
  private lastStats: NgRxResolutionStats | null = null;

  constructor(storage: IIndexStorage) {
    this.storage = storage;
  }

  /**
   * Resolve all pending NgRx references across the workspace.
   * Uses SQL queries for fast discovery of action groups and pending references.
   * 
   * @returns Statistics about the resolution process
   */
  async resolveAll(): Promise<NgRxResolutionStats> {
    const startTime = Date.now();
    
    console.info('[NgRxLinkResolver] Starting resolution phase via SQL...');
    
    // STEP 1: Fast SQL-based discovery
    console.info('[NgRxLinkResolver] Step 1: Querying SQL for action groups and files with pending refs...');
    
    const actionGroupSymbols = await this.storage.findNgRxActionGroups();
    const actionGroupLookup = new Map<string, ActionGroupEntry>();
    
    for (const entry of actionGroupSymbols) {
      if (entry.symbol.ngrxMetadata?.events) {
        actionGroupLookup.set(entry.symbol.name, {
          uri: entry.uri,
          events: entry.symbol.ngrxMetadata.events as Record<string, string>
        });
      }
    }
    
    const fileUrisWithPending = await this.storage.findFilesWithPendingRefs();
    
    console.info(
      `[NgRxLinkResolver] Step 1 complete: Found ${actionGroupLookup.size} action groups, ` +
      `${fileUrisWithPending.length} files with pending refs`
    );
    
    if (fileUrisWithPending.length === 0) {
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
    
    // STEP 2 & 3: Resolve and Update
    console.info('[NgRxLinkResolver] Step 2 & 3: Resolving and updating shards...');
    
    let ngrxResolved = 0;
    let fallbackResolved = 0;
    let shardsModified = 0;
    let totalPending = 0;
    
    for (const uri of fileUrisWithPending) {
      try {
        await this.storage.withLock(uri, async () => {
          const shard = await this.storage.getFileNoLock(uri);
          if (!shard || !shard.pendingReferences || shard.pendingReferences.length === 0) {
            return;
          }
          
          totalPending += shard.pendingReferences.length;
          const update: ShardUpdate = {
            newRefs: [],
            resolvedKeys: new Set(),
            ngrxCount: 0,
            fallbackCount: 0
          };
          
          for (const pending of shard.pendingReferences) {
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
            }
          }
          
          if (update.newRefs.length > 0) {
            // Dedup and add new refs
            shard.references = shard.references || [];
            const existingRefKeys = new Set(
              shard.references.map(r => `${r.symbolName}:${r.location.line}:${r.location.character}`)
            );
            
            for (const newRef of update.newRefs) {
              const refKey = `${newRef.symbolName}:${newRef.location.line}:${newRef.location.character}`;
              if (!existingRefKeys.has(refKey)) {
                shard.references.push(newRef);
                existingRefKeys.add(refKey);
              }
            }
            
            // Filter out resolved pending refs
            shard.pendingReferences = shard.pendingReferences.filter(pr => {
              const key = `${pr.container}:${pr.member}:${pr.location.line}:${pr.location.character}`;
              return !update.resolvedKeys.has(key);
            });
            
            // Update counts for stats
            ngrxResolved += update.ngrxCount;
            fallbackResolved += update.fallbackCount;
            shardsModified++;
            
            // Save updated shard
            await this.storage.storeFileNoLock(shard);
          }
        });
      } catch (error: any) {
        console.warn(`[NgRxLinkResolver] Failed to process ${uri}: ${error.message}`);
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
      filesWithPending: fileUrisWithPending.length,
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
