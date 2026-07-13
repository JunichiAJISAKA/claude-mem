import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { SessionStore } from '../../../src/services/sqlite/SessionStore.js';
import {
  claimNovelSemanticInjectObservationIds,
  SEMANTIC_INJECT_DEDUP_RETENTION_MS,
} from '../../../src/services/sqlite/semantic-inject-dedup.js';

describe('semantic inject SQLite dedup claims', () => {
  let store: SessionStore;
  let observationIds: number[];

  beforeEach(() => {
    store = new SessionStore(':memory:');
    const sessionDbId = store.createSDKSession('dedup-source-content', 'dedup-project', 'seed');
    store.updateMemorySessionId(sessionDbId, 'dedup-source-memory');
    observationIds = Array.from({ length: 3 }, (_, index) => store.storeObservation(
      'dedup-source-memory',
      'dedup-project',
      {
        type: 'discovery',
        title: `dedup-${index + 1}`,
        subtitle: null,
        facts: [],
        narrative: `semantic dedup ${index + 1}`,
        concepts: [],
        files_read: [],
        files_modified: [],
      },
    ).id);
  });

  afterEach(() => {
    store.close();
  });

  it('claims unique candidates in ranking order and isolates sessions', () => {
    const [first, second, third] = observationIds;

    expect(claimNovelSemanticInjectObservationIds(
      store.db,
      'session-a',
      [first, first, second, third],
      2,
    )).toEqual([first, second]);
    expect(claimNovelSemanticInjectObservationIds(
      store.db,
      'session-a',
      [first, second, third],
      2,
    )).toEqual([third]);
    expect(claimNovelSemanticInjectObservationIds(
      store.db,
      'session-b',
      [first, second, third],
      2,
    )).toEqual([first, second]);
  });

  it('prunes expired claims before selecting novel candidates', () => {
    const [first] = observationIds;
    const initialInjection = Date.UTC(2026, 6, 1);

    expect(claimNovelSemanticInjectObservationIds(
      store.db,
      'long-session',
      [first],
      1,
      initialInjection,
    )).toEqual([first]);
    expect(claimNovelSemanticInjectObservationIds(
      store.db,
      'long-session',
      [first],
      1,
      initialInjection + SEMANTIC_INJECT_DEDUP_RETENTION_MS + 1,
    )).toEqual([first]);
  });
});
