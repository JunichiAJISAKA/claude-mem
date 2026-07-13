import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { SearchRoutes } from '../../../../src/services/worker/http/routes/SearchRoutes.js';

type SemanticHandler = (req: Request, res: Response) => void;

interface SemanticResponse {
  context: string;
  count: number;
}

interface RankedObservation {
  id: number;
  title: string;
  narrative: string;
  created_at: string;
}

const stores: SessionStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      // A persistence test closes the first worker connection explicitly.
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function captureSemanticHandler(routes: SearchRoutes): SemanticHandler {
  let middleware: ((req: Request, res: Response, next: () => void) => void) | undefined;
  let handler: SemanticHandler | undefined;
  const app = {
    use: mock(() => {}),
    get: mock(() => {}),
    post: mock((path: string, ...rest: any[]) => {
      if (path !== '/api/context/semantic') return;
      if (rest.length === 1) {
        handler = rest[0];
      } else {
        middleware = rest[0];
        handler = rest[1];
      }
    }),
  };

  routes.setupRoutes(app as any);
  if (!handler) throw new Error('Failed to capture /api/context/semantic handler');

  return (req: Request, res: Response): void => {
    if (!middleware) {
      handler!(req, res);
      return;
    }

    let nextCalled = false;
    middleware(req, res, () => { nextCalled = true; });
    if (nextCalled) handler!(req, res);
  };
}

function seedRankedObservations(store: SessionStore): RankedObservation[] {
  const project = 'semantic-dedup-project';
  const sessionDbId = store.createSDKSession('semantic-source-content', project, 'seed observations');
  store.updateMemorySessionId(sessionDbId, 'semantic-source-memory');

  return Array.from({ length: 5 }, (_, index) => {
    const position = index + 1;
    const createdAtEpoch = Date.UTC(2026, 6, position);
    const inserted = store.storeObservation(
      'semantic-source-memory',
      project,
      {
        type: 'discovery',
        title: `RANKED_OBS_${position}`,
        subtitle: null,
        facts: [`rank ${position}`],
        narrative: `Ranked semantic narrative ${position}`,
        concepts: ['semantic-dedup'],
        files_read: [],
        files_modified: [],
      },
      position,
      0,
      createdAtEpoch,
    );

    return {
      id: inserted.id,
      title: `RANKED_OBS_${position}`,
      narrative: `Ranked semantic narrative ${position}`,
      created_at: new Date(createdAtEpoch).toISOString(),
    };
  });
}

function makeRoutes(store: SessionStore, ranked: RankedObservation[]): {
  handler: SemanticHandler;
  search: ReturnType<typeof mock>;
} {
  const search = mock(async (options: Record<string, unknown>) => ({
    observations: ranked.slice(0, Number(options.limit)),
  }));
  const routes = new SearchRoutes({
    search,
    getSessionStore: () => store,
  } as any);
  return { handler: captureSemanticHandler(routes), search };
}

async function invokeSemantic(
  handler: SemanticHandler,
  input: { sessionId: string; limit?: number; dedup?: boolean },
): Promise<SemanticResponse> {
  const json = mock(() => {});
  const res = {
    headersSent: false,
    locals: {},
    json,
    status: mock(() => res),
  } as any;
  const req = {
    path: '/api/context/semantic',
    body: {
      q: 'Find the ranked semantic observations relevant to this repeated orchestration prompt',
      project: 'semantic-dedup-project',
      limit: input.limit ?? 2,
      sessionId: input.sessionId,
      dedup: input.dedup ?? true,
    },
    query: {},
    get: () => undefined,
  } as any;

  handler(req as Request, res as Response);
  await new Promise(resolve => setImmediate(resolve));

  expect(json).toHaveBeenCalledTimes(1);
  return (json as any).mock.calls[0][0] as SemanticResponse;
}

function expectTitles(response: SemanticResponse, included: number[], excluded: number[] = []): void {
  expect(response.count).toBe(included.length);
  for (const rank of included) {
    expect(response.context).toContain(`RANKED_OBS_${rank}`);
  }
  for (const rank of excluded) {
    expect(response.context).not.toContain(`RANKED_OBS_${rank}`);
  }
}

describe('/api/context/semantic session-scoped dedup', () => {
  it('backfills from lower-ranked novel observations on a repeated query in the same session', async () => {
    const store = new SessionStore(':memory:');
    stores.push(store);
    const ranked = seedRankedObservations(store);
    const { handler, search } = makeRoutes(store, ranked);

    const first = await invokeSemantic(handler, { sessionId: 'session-a' });
    const second = await invokeSemantic(handler, { sessionId: 'session-a' });
    const third = await invokeSemantic(handler, { sessionId: 'session-a' });
    const exhausted = await invokeSemantic(handler, { sessionId: 'session-a' });

    expectTitles(first, [1, 2], [3, 4]);
    expectTitles(second, [3, 4], [1, 2, 5]);
    expectTitles(third, [5], [1, 2, 3, 4]);
    expect(exhausted).toEqual({ context: '', count: 0 });
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ limit: '100' }));
  });

  it('does not exclude observations injected into a different session', async () => {
    const store = new SessionStore(':memory:');
    stores.push(store);
    const { handler } = makeRoutes(store, seedRankedObservations(store));

    const sessionA = await invokeSemantic(handler, { sessionId: 'session-a' });
    const sessionB = await invokeSemantic(handler, { sessionId: 'session-b' });

    expectTitles(sessionA, [1, 2]);
    expectTitles(sessionB, [1, 2]);
  });

  it('restores repeated injection when dedup is disabled', async () => {
    const store = new SessionStore(':memory:');
    stores.push(store);
    const { handler, search } = makeRoutes(store, seedRankedObservations(store));

    const first = await invokeSemantic(handler, { sessionId: 'session-a', dedup: false });
    const second = await invokeSemantic(handler, { sessionId: 'session-a', dedup: false });

    expectTitles(first, [1, 2], [3]);
    expectTitles(second, [1, 2], [3]);
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ limit: '2' }));
  });

  it('persists claimed observations across a worker database restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mem-semantic-dedup-'));
    tempDirs.push(dir);
    const dbPath = join(dir, 'claude-mem.db');

    const firstStore = new SessionStore(dbPath);
    stores.push(firstStore);
    const ranked = seedRankedObservations(firstStore);
    const firstWorker = makeRoutes(firstStore, ranked);
    const first = await invokeSemantic(firstWorker.handler, { sessionId: 'restart-session' });
    expectTitles(first, [1, 2]);

    firstStore.close();
    const secondStore = new SessionStore(dbPath);
    stores.push(secondStore);
    const secondWorker = makeRoutes(secondStore, ranked);
    const second = await invokeSemantic(secondWorker.handler, { sessionId: 'restart-session' });

    expectTitles(second, [3, 4], [1, 2]);
  });

  it('never returns more observations than the requested limit', async () => {
    const store = new SessionStore(':memory:');
    stores.push(store);
    const { handler } = makeRoutes(store, seedRankedObservations(store));

    const response = await invokeSemantic(handler, { sessionId: 'limited-session', limit: 1 });

    expectTitles(response, [1], [2, 3, 4, 5]);
  });
});
