import type { Database } from 'bun:sqlite';
import { logger } from '../../utils/logger.js';

export const SEMANTIC_INJECT_DEDUP_SCHEMA_VERSION = 41;
export const SEMANTIC_INJECT_DEDUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function ensureSemanticInjectDedupSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS semantic_inject_history (
      session_id TEXT NOT NULL,
      observation_id INTEGER NOT NULL,
      injected_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, observation_id),
      FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_semantic_inject_history_injected_at
      ON semantic_inject_history(injected_at);
  `);

  db.prepare('INSERT OR IGNORE INTO schema_versions (version, applied_at) VALUES (?, ?)')
    .run(SEMANTIC_INJECT_DEDUP_SCHEMA_VERSION, new Date().toISOString());
}

export function claimNovelSemanticInjectObservationIds(
  db: Database,
  sessionId: string,
  candidateIds: number[],
  limit: number,
  injectedAt: number = Date.now(),
): number[] {
  const normalizedSessionId = sessionId.trim();
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (!normalizedSessionId || normalizedLimit === 0 || candidateIds.length === 0) {
    return [];
  }

  const claim = db.transaction((): number[] => {
    const pruned = db.prepare('DELETE FROM semantic_inject_history WHERE injected_at < ?')
      .run(injectedAt - SEMANTIC_INJECT_DEDUP_RETENTION_MS);
    if (pruned.changes > 0) {
      logger.debug('DB', 'Pruned expired semantic inject history', { pruned: pruned.changes });
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO semantic_inject_history (session_id, observation_id, injected_at)
      VALUES (?, ?, ?)
    `);
    const selected: number[] = [];
    const seenCandidates = new Set<number>();

    for (const observationId of candidateIds) {
      if (selected.length >= normalizedLimit) break;
      if (!Number.isSafeInteger(observationId) || observationId <= 0 || seenCandidates.has(observationId)) continue;
      seenCandidates.add(observationId);

      const result = insert.run(normalizedSessionId, observationId, injectedAt);
      if (result.changes > 0) {
        selected.push(observationId);
      }
    }

    return selected;
  });

  return claim();
}
