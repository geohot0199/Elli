import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type {
  ForgetMemoryGraphInput,
  GraphRecalledMemory,
  ReadOnlyGraphQueryResult,
  RecallMemoryGraphInput,
  SaveMemoryGraphInput,
} from "./falkordb-graph.js";
import {
  classifyFalkorConnectionSettings,
  createFalkorProvider,
  type FalkorConnectionConfig,
  FalkorConnectionPool,
  FalkorMemoryProvider,
  type FalkorServer,
  falkorClientUrl,
  falkordbRequiresDeploymentOwner,
  parseFalkorSettings,
  prepareFalkorConnection,
} from "./falkordb-memory-provider.js";
import { MemoryProviderDeploymentOwnerRequiredError } from "./memory-provider-error.js";

const config: FalkorConnectionConfig = {
  url: "falkordb://localhost:6379",
  namespace: "rakazo",
  maxHops: 2,
  allowWrites: true,
  timeoutMs: 5_000,
  endpointTrust: "private",
};

const context: AdapterContext = {
  operationId: "op-1",
  traceId: "trace-1",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
  threadId: "thread-1",
  signal: new AbortController().signal,
};

class FakeMemoryGraph {
  readonly saves: SaveMemoryGraphInput[] = [];
  readonly recalls: RecallMemoryGraphInput[] = [];
  readonly forgets: ForgetMemoryGraphInput[] = [];
  readonly purges: Array<{ botId: string; generations: number[] }> = [];
  recallResult: GraphRecalledMemory[] = [];
  readResult: ReadOnlyGraphQueryResult = {
    columns: ["key"],
    rows: [{ key: "acme" }],
    truncated: false,
    graph: "rakazo_space_test",
  };
  lastRead: { cypher: string; limit?: number } | null = null;
  graphName = "rakazo_space_test";

  async saveMemory(input: SaveMemoryGraphInput) {
    this.saves.push(input);
    return { id: input.id };
  }

  async recallMemories(input: RecallMemoryGraphInput) {
    this.recalls.push(input);
    return this.recallResult;
  }

  async forgetMemory(input: ForgetMemoryGraphInput) {
    this.forgets.push(input);
    return { expired: true };
  }

  async purgeHistory(input: { botId: string; generations: number[] }) {
    this.purges.push(input);
  }

  async runReadOnlyQuery(cypher: string, limit?: number) {
    this.lastRead = { cypher, ...(limit === undefined ? {} : { limit }) };
    return this.readResult;
  }
}

function providerFor(graph: FakeMemoryGraph, overrides: Partial<FalkorConnectionConfig> = {}) {
  return new FalkorMemoryProvider({ ...config, ...overrides }, { graphFor: async () => graph });
}

describe("settings", () => {
  it("normalizes defaults and the endpoint scheme", () => {
    expect(parseFalkorSettings({ url: "redis://localhost" }, {})).toMatchObject({
      url: "falkordb://localhost:6379",
      namespace: "rakazo",
      maxHops: 2,
      allowWrites: true,
      timeoutMs: 5_000,
      endpointTrust: "public",
    });
    expect(parseFalkorSettings({ url: "rediss://graph.example.com:6380" }, {}).url).toBe(
      "rediss://graph.example.com:6380",
    );
    expect(
      parseFalkorSettings(
        { url: "falkordb://graph:6379", maxHops: "3", allowWrites: "false", namespace: "team" },
        { username: "rakazo", password: "secret" },
      ),
    ).toMatchObject({ maxHops: 3, allowWrites: false, namespace: "team", username: "rakazo" });
  });

  it("hands node-redis a valid scheme", () => {
    expect(falkorClientUrl("falkordb://graph:6379")).toBe("redis://graph:6379");
    expect(falkorClientUrl("redis://graph:6379")).toBe("redis://graph:6379");
    expect(falkorClientUrl("rediss://graph:6379")).toBe("rediss://graph:6379");
  });

  it.each([
    [{ url: "" }, {}, "required"],
    [{ url: "http://localhost:6379" }, {}, "scheme"],
    [{ url: "falkordb://user:pass@localhost:6379" }, {}, "credentials"],
    [{ url: "falkordb://localhost:6379/path" }, {}, "path"],
    [{ url: "falkordb://localhost:6379", maxHops: "9" }, {}, "maxHops"],
    [{ url: "falkordb://localhost:6379", allowWrites: "maybe" }, {}, "boolean"],
    [{ url: "falkordb://localhost:6379" }, { username: "rakazo" }, "password"],
  ])("rejects invalid settings %#", (settings, credentials, message) => {
    expect(() => parseFalkorSettings(settings, credentials)).toThrow(message);
  });

  it("gates private endpoints for the deployment owner", () => {
    expect(falkordbRequiresDeploymentOwner({ url: "falkordb://localhost:6379" })).toBe(true);
    expect(falkordbRequiresDeploymentOwner({ url: "falkordb://127.0.0.1:6379" })).toBe(true);
    expect(falkordbRequiresDeploymentOwner({ url: "falkordb://10.0.0.4:6379" })).toBe(true);
    expect(falkordbRequiresDeploymentOwner({ url: "falkordb://graph.example.com:6379" })).toBe(
      false,
    );
    expect(falkordbRequiresDeploymentOwner({ url: "not a url" })).toBe(false);
  });

  it("classifies DNS results without connecting", async () => {
    const privateSettings = await classifyFalkorConnectionSettings(
      { url: "falkordb://graph.example.com:6379" },
      async () => [{ address: "10.1.2.3", family: 4 }],
    );
    expect(privateSettings.endpointTrust).toBe("private");

    const publicSettings = await classifyFalkorConnectionSettings(
      { url: "falkordb://graph.example.com:6379" },
      async () => [{ address: "93.184.216.34", family: 4 }],
    );
    expect(publicSettings.endpointTrust).toBeUndefined();

    await expect(
      classifyFalkorConnectionSettings({ url: "falkordb://graph.example.com:6379" }, async () => [
        { address: "169.254.169.254", family: 4 },
      ]),
    ).rejects.toThrow("blocked");
  });
});

function fakeServer() {
  const queries: string[] = [];
  let closed = false;
  const server: FalkorServer = {
    selectGraph: () => ({
      query: async () => [],
      roQuery: async (cypher) => {
        queries.push(cypher);
        return [];
      },
    }),
    close: async () => {
      closed = true;
    },
  };
  return { server, queries, isClosed: () => closed };
}

describe("prepareFalkorConnection", () => {
  it("probes with a read-only query and stores normalized settings", async () => {
    const fake = fakeServer();
    const prepared = await prepareFalkorConnection(
      { url: "falkordb://127.0.0.1" },
      { password: "secret" },
      { connect: async () => fake.server },
    );
    expect(fake.queries).toEqual(["RETURN 1 AS ok"]);
    expect(fake.isClosed()).toBe(true);
    expect(prepared.settings).toMatchObject({
      url: "falkordb://127.0.0.1:6379",
      allowWrites: "true",
      endpointTrust: "private",
    });
    expect(prepared.credentials).toEqual({ password: "secret" });
  });

  it("refuses to probe a private endpoint for non-owners", async () => {
    const connect = vi.fn();
    await expect(
      prepareFalkorConnection(
        { url: "falkordb://10.0.0.5:6379" },
        {},
        { connect },
        { allowPrivateEndpoint: false },
      ),
    ).rejects.toBeInstanceOf(MemoryProviderDeploymentOwnerRequiredError);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("connection pool", () => {
  it("reuses connections per endpoint and evicts idle ones", async () => {
    const servers: ReturnType<typeof fakeServer>[] = [];
    const connect = vi.fn(async () => {
      const fake = fakeServer();
      servers.push(fake);
      return fake.server;
    });
    const pool = new FalkorConnectionPool(connect, { idleMs: 1_000, maxConnections: 2 });

    await pool.acquire(config);
    await pool.acquire(config);
    expect(connect).toHaveBeenCalledTimes(1);

    await pool.acquire({ ...config, url: "falkordb://other:6379" });
    expect(connect).toHaveBeenCalledTimes(2);

    await pool.sweep(Date.now() + 5_000);
    expect(servers[0]?.isClosed()).toBe(true);
    await pool.acquire(config);
    expect(connect).toHaveBeenCalledTimes(3);

    await pool.closeAll();
    expect(pool.size).toBe(0);
  });

  it("does not cache a failed connection", async () => {
    const connect = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const pool = new FalkorConnectionPool(connect);
    await expect(pool.acquire(config)).rejects.toThrow("ECONNREFUSED");
    await expect(pool.acquire(config)).rejects.toThrow("ECONNREFUSED");
    expect(connect).toHaveBeenCalledTimes(2);
    expect(pool.size).toBe(0);
  });
});

describe("FalkorMemoryProvider", () => {
  it("declares graph capabilities", () => {
    const described = providerFor(new FakeMemoryGraph()).describe();
    expect(described.id).toBe("falkordb");
    expect(described.capabilities.graphQuery).toBe(true);
    expect(createFalkorProvider({ url: "falkordb://localhost:6379" }, {}).describe().id).toBe(
      "falkordb",
    );
  });

  it("maps graph recall results into memory citations", async () => {
    const graph = new FakeMemoryGraph();
    graph.recallResult = [
      {
        id: "m_1",
        text: "Acme renewal is owned by Priya",
        scope: "isolated",
        kind: "durable",
        botId: "bot-1",
        updatedAt: "2026-10-01T00:00:00.000Z",
        score: 0.82,
        entities: ["acme"],
        provenance: "rakazo_space_test · direct: acme",
        entity: "bot:bot-1",
      },
    ];
    const provider = providerFor(graph);
    const result = await provider.recall(
      { query: "Who owns Acme?", scope: "isolated", botId: "bot-1", limit: 3 },
      context,
    );
    expect(result).toEqual({
      ok: true,
      value: [
        {
          memory: "Acme renewal is owned by Priya",
          score: 0.82,
          updatedAt: "2026-10-01T00:00:00.000Z",
          id: "m_1",
          provenance: "rakazo_space_test · direct: acme",
          entity: "bot:bot-1",
        },
      ],
    });
    expect(graph.recalls[0]).toMatchObject({
      spaceId: "space-1",
      botId: "bot-1",
      scope: "isolated",
      limit: 3,
      maxHops: 2,
    });
  });

  it("skips the graph for a blank query and reports failures", async () => {
    const graph = new FakeMemoryGraph();
    const provider = providerFor(graph);
    await expect(
      provider.recall({ query: "   ", scope: "isolated", botId: "bot-1", limit: 3 }, context),
    ).resolves.toEqual({ ok: true, value: [] });
    expect(graph.recalls).toHaveLength(0);

    const failing = new FalkorMemoryProvider(config, {
      graphFor: async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:6379");
      },
    });
    const result = await failing.recall(
      { query: "Acme", scope: "isolated", botId: "bot-1", limit: 3 },
      context,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unreachable");
  });

  it("saves deterministic ids with entities and provenance", async () => {
    const graph = new FakeMemoryGraph();
    const provider = providerFor(graph);
    const save = () =>
      provider.save(
        {
          content: "Acme renewal is owned by Priya",
          scope: "shared",
          botId: "bot-1",
          source: { kind: "durable" },
        },
        context,
      );
    await expect(save()).resolves.toEqual({ ok: true, value: undefined });
    await expect(save()).resolves.toEqual({ ok: true, value: undefined });

    expect(graph.saves).toHaveLength(2);
    expect(graph.saves[0]?.id).toBe(graph.saves[1]?.id);
    expect(graph.saves[0]).toMatchObject({
      kind: "durable",
      scope: "shared",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "user-1",
      sourceRunId: "run-1",
      sourceThreadId: "thread-1",
    });
    expect(graph.saves[0]?.entities.map((entity) => entity.key)).toContain("acme");
    expect(graph.saves[0]?.generation).toBeUndefined();
  });

  it("stores history summaries with their compaction generation", async () => {
    const graph = new FakeMemoryGraph();
    await providerFor(graph).save(
      {
        content: "Conversation summary: Acme renewal",
        scope: "isolated",
        botId: "bot-1",
        source: { kind: "history", generation: 4 },
      },
      context,
    );
    expect(graph.saves[0]).toMatchObject({ kind: "history", generation: 4 });
    expect(graph.saves[0]?.id).toMatch(/^h_/);
  });

  it("enforces write mode and content bounds", async () => {
    const graph = new FakeMemoryGraph();
    const readOnly = providerFor(graph, { allowWrites: false });
    const request = {
      content: "Acme",
      scope: "isolated" as const,
      botId: "bot-1",
      source: { kind: "durable" as const },
    };
    await expect(readOnly.save(request, context)).resolves.toMatchObject({ ok: false });
    expect(graph.saves).toHaveLength(0);

    const provider = providerFor(graph);
    await expect(provider.save({ ...request, content: "   " }, context)).resolves.toMatchObject({
      ok: false,
    });
    await expect(
      provider.save({ ...request, content: "x".repeat(8_001) }, context),
    ).resolves.toMatchObject({ ok: false });
  });

  it("forgets and purges inside the Space", async () => {
    const graph = new FakeMemoryGraph();
    const provider = providerFor(graph);
    await expect(provider.forget({ id: "m_1", reason: "stale" }, context)).resolves.toEqual({
      ok: true,
      value: { id: "m_1", expired: true, reason: "stale" },
    });
    expect(graph.forgets[0]).toMatchObject({
      memoryId: "m_1",
      spaceId: "space-1",
      botId: "bot-1",
      reason: "stale",
    });

    await provider.purgeHistory({ botId: "bot-1", generations: [2, 3] }, context);
    expect(graph.purges[0]).toEqual({ botId: "bot-1", generations: [2, 3] });

    const readOnly = providerFor(new FakeMemoryGraph(), { allowWrites: false });
    const other = new FakeMemoryGraph();
    await new FalkorMemoryProvider(
      { ...config, allowWrites: false },
      { graphFor: async () => other },
    ).purgeHistory({ botId: "bot-1", generations: [2] }, context);
    expect(other.purges).toHaveLength(0);
    expect(readOnly.describe().id).toBe("falkordb");
  });

  it("runs read-only graph queries and surfaces guard errors", async () => {
    const graph = new FakeMemoryGraph();
    const provider = providerFor(graph);
    await expect(
      provider.queryGraph({ cypher: "MATCH (n) RETURN n", limit: 5 }, context),
    ).resolves.toEqual({
      ok: true,
      value: graph.readResult,
    });
    expect(graph.lastRead).toEqual({ cypher: "MATCH (n) RETURN n", limit: 5 });

    const guard = new FalkorMemoryProvider(config, {
      graphFor: async () => ({
        ...graph,
        runReadOnlyQuery: async () => {
          throw new Error('Writes are not allowed in memory graph queries (found "create").');
        },
      }),
    });
    const rejected = await guard.queryGraph({ cypher: "CREATE (n)" }, context);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toContain("Writes are not allowed");
  });

  it("honours an aborted run", async () => {
    const controller = new AbortController();
    controller.abort(new Error("run cancelled"));
    const result = await providerFor(new FakeMemoryGraph()).recall(
      { query: "Acme", scope: "isolated", botId: "bot-1", limit: 3 },
      { ...context, signal: controller.signal },
    );
    expect(result).toMatchObject({ ok: false });
  });
});
