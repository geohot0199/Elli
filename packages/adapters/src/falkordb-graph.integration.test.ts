import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractMemoryEntities, FalkorMemoryGraph, spaceGraphName } from "./falkordb-graph.js";
import {
  createFalkorProvider,
  defaultFalkorConnect,
  FalkorConnectionPool,
  type FalkorServer,
} from "./falkordb-memory-provider.js";

/**
 * Runs only when a real FalkorDB is available:
 *   FALKORDB_URL=falkordb://localhost:6379 pnpm test
 *
 * The unit suite covers query construction and scoring with doubles; this file proves
 * the Cypher executes on the server and the recall/scoping behaviour holds end to end.
 */
const url = process.env.FALKORDB_URL;
const describeFalkor = url ? describe.sequential : describe.skip;

describeFalkor("FalkorDB memory graph (integration)", () => {
  const spaceId = `it-space-${Date.now()}`;
  const graphName = spaceGraphName("rakazo_it", spaceId);
  const config = {
    url: url ?? "falkordb://localhost:6379",
    namespace: "rakazo_it",
    maxHops: 2,
    allowWrites: true,
    timeoutMs: 10_000,
    endpointTrust: "private" as const,
  };
  let server: FalkorServer;
  let graph: FalkorMemoryGraph;
  let now = Date.now();

  beforeAll(async () => {
    server = await defaultFalkorConnect(config);
    graph = new FalkorMemoryGraph(server.selectGraph(graphName), {
      graphName,
      now: () => now,
    });
  });

  afterAll(async () => {
    await server?.selectGraph(graphName).query("MATCH (n) DETACH DELETE n");
    await server?.close();
  });

  async function save(botId: string, scope: "isolated" | "shared", text: string) {
    now += 1_000;
    const id = `${botId}-${text.length}-${now}`;
    await graph.saveMemory({
      id,
      text,
      kind: "durable",
      scope,
      spaceId,
      botId,
      userId: `user-${botId}`,
      sourceThreadId: "thread-it",
      entities: extractMemoryEntities(text),
    });
    return id;
  }

  it("writes, recalls across hops, and explains the trail", async () => {
    await save(
      "atlas",
      "isolated",
      "Northwind Robotics renewed the Atlas contract. Priya Raman owns the renewal and the security review.",
    );
    await save(
      "atlas",
      "isolated",
      "The Atlas security review is blocked by missing SOC 2 evidence from the billing-api team.",
    );
    await save(
      "sentinel",
      "shared",
      "Incident INC-2041: a retry storm in invoice-worker hit billing-api during the monthly close.",
    );

    const recalled = await graph.recallMemories({
      spaceId,
      botId: "atlas",
      userId: "user-atlas",
      scope: "isolated",
      query: "What is blocking the Atlas renewal?",
      limit: 5,
      maxHops: 2,
    });
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled[0]?.text).toContain("Atlas");
    expect(recalled.some((memory) => memory.provenance.includes("direct:"))).toBe(true);
    expect(recalled[0]?.entity).toBe("bot:atlas");
  });

  it("enforces bot scope and soft deletes", async () => {
    const isolatedSentinelId = await save(
      "sentinel",
      "isolated",
      "Sentinel runbook: restart invoice-worker before paging billing-api.",
    );

    const sentinelOnly = await graph.recallMemories({
      spaceId,
      botId: "sentinel",
      userId: "user-sentinel",
      scope: "isolated",
      query: "billing-api incident",
      limit: 5,
      maxHops: 2,
    });
    expect(sentinelOnly.length).toBeGreaterThan(0);
    expect(sentinelOnly.every((memory) => memory.botId === "sentinel")).toBe(true);
    expect(sentinelOnly.some((memory) => memory.text.includes("Northwind Robotics renewed"))).toBe(
      false,
    );

    const shared = await graph.recallMemories({
      spaceId,
      botId: "atlas",
      userId: "user-atlas",
      scope: "shared",
      query: "billing-api",
      limit: 5,
      maxHops: 2,
    });
    expect(shared.some((memory) => memory.scope === "shared")).toBe(true);

    await graph.forgetMemory({
      memoryId: isolatedSentinelId,
      spaceId,
      botId: "sentinel",
      reason: "integration forget",
    });
    const afterForget = await graph.recallMemories({
      spaceId,
      botId: "sentinel",
      userId: "user-sentinel",
      scope: "isolated",
      query: "billing-api incident",
      limit: 5,
      maxHops: 2,
    });
    expect(afterForget.map((memory) => memory.id)).not.toContain(isolatedSentinelId);
  });

  it("runs read-only Cypher and rejects writes", async () => {
    const result = await graph.runReadOnlyQuery(
      "MATCH (b:Bot)-[:REMEMBERS]->(m:Memory) RETURN b.id AS bot, count(m) AS memories ORDER BY bot ASC",
      10,
    );
    expect(result.columns).toEqual(["bot", "memories"]);
    expect(result.rows.length).toBeGreaterThan(0);
    await expect(graph.runReadOnlyQuery("MATCH (n) DETACH DELETE n")).rejects.toThrow(
      "Writes are not allowed",
    );
  });
});

describeFalkor("FalkorDB memory provider (integration)", () => {
  const spaceId = `it-provider-${Date.now()}`;
  const namespace = "rakazo_it";
  const pool = new FalkorConnectionPool(defaultFalkorConnect, { idleMs: 60_000 });
  const provider = createFalkorProvider(
    { url: url ?? "", namespace, maxHops: "2", allowWrites: "true", timeoutMs: "10000" },
    {},
    { pool },
  );
  const signal = new AbortController().signal;
  const context = {
    operationId: "op-it",
    traceId: "trace-it",
    spaceId,
    userId: "priya",
    botId: "atlas",
    threadId: "thread-it",
    signal,
  };

  afterAll(async () => {
    await pool.closeAll();
  });

  it("saves and recalls through the provider with a graph trail", async () => {
    const saved = await provider.save(
      {
        content:
          "The Atlas renewal depends on the billing-api SOC 2 evidence owned by Marco Silva.",
        scope: "isolated",
        botId: "atlas",
        source: { kind: "durable" },
      },
      context,
    );
    expect(saved).toEqual({ ok: true, value: undefined });

    const recalled = await provider.recall(
      {
        query: "who owns the SOC 2 evidence for the renewal?",
        scope: "isolated",
        botId: "atlas",
        limit: 5,
      },
      context,
    );
    expect(recalled.ok).toBe(true);
    const memories = recalled.ok ? recalled.value : [];
    expect(memories[0]?.memory).toContain("SOC 2 evidence");
    expect(memories[0]?.provenance).toContain("direct:");
    expect(memories[0]?.id).toMatch(/^m_/);
  });

  it("answers read-only Cypher and rejects writes", async () => {
    const answer = await provider.queryGraph!(
      {
        cypher:
          "MATCH (b:Bot)-[:REMEMBERS]->(m:Memory)-[:MENTIONS]->(e:Entity) RETURN b.id AS bot, count(DISTINCT m) AS memories ORDER BY bot",
      },
      context,
    );
    expect(answer.ok).toBe(true);
    const result = answer.ok ? answer.value : undefined;
    expect(result?.columns).toEqual(["bot", "memories"]);
    expect(result?.rows).toEqual([{ bot: "atlas", memories: 1 }]);

    const rejected = await provider.queryGraph!({ cypher: "CREATE (n:Hacked) RETURN n" }, context);
    expect(rejected.ok).toBe(false);
    expect(rejected.ok ? "" : rejected.error).toContain("read-only");
  });

  it("purges history generations without touching durable facts", async () => {
    await provider.save(
      {
        content: "Summary of turn 1",
        scope: "isolated",
        botId: "atlas",
        source: { kind: "history", generation: 1 },
      },
      context,
    );
    await provider.save(
      {
        content: "Summary of turn 2",
        scope: "isolated",
        botId: "atlas",
        source: { kind: "history", generation: 2 },
      },
      context,
    );
    await provider.purgeHistory({ botId: "atlas", generations: [1] }, context);

    const durable = await provider.recall(
      { query: "SOC 2 evidence", scope: "isolated", botId: "atlas", limit: 5 },
      context,
    );
    expect(
      durable.ok && durable.value.some((memory) => memory.memory.includes("Marco Silva")),
    ).toBe(true);

    const purged = await provider.queryGraph!(
      {
        cypher:
          "MATCH (m:Memory {kind: 'history'}) RETURN m.generation AS generation, count(m) AS total ORDER BY generation",
      },
      context,
    );
    expect(purged.ok ? purged.value.rows : []).toEqual([{ generation: 2, total: 1 }]);
  });
});
