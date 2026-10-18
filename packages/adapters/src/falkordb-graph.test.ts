import { describe, expect, it } from "vitest";
import {
  assertReadOnlyCypher,
  extractMemoryEntities,
  type FalkorGraphConnection,
  FalkorMemoryGraph,
  type FalkorParams,
  type FalkorRow,
  memoryNodeId,
  sanitizeGraphNamespace,
  spaceGraphName,
  tokenizeForSearch,
} from "./falkordb-graph.js";

type Call = { kind: "query" | "roQuery"; cypher: string; params?: FalkorParams };

class FakeConnection implements FalkorGraphConnection {
  readonly calls: Call[] = [];

  constructor(private readonly respond: (call: Call) => FalkorRow[] = () => []) {}

  async query(cypher: string, params?: FalkorParams): Promise<FalkorRow[]> {
    const call: Call = { kind: "query", cypher, ...(params ? { params } : {}) };
    this.calls.push(call);
    return this.respond(call);
  }

  async roQuery(cypher: string, params?: FalkorParams): Promise<FalkorRow[]> {
    const call: Call = { kind: "roQuery", cypher, ...(params ? { params } : {}) };
    this.calls.push(call);
    return this.respond(call);
  }
}

const memoryRow = (overrides: Record<string, unknown> = {}) => ({
  id: "m_1",
  text: "The Acme renewal is owned by Priya",
  kind: "durable",
  scope: "isolated",
  botId: "bot-1",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  entities: ["acme"],
  ...overrides,
});

describe("entity extraction", () => {
  it("drops leading articles from capitalised runs", () => {
    const entities = extractMemoryEntities("The Atlas review and a Northwind renewal");
    const names = entities.map((entity) => entity.name);
    expect(names).toContain("Atlas");
    expect(names).not.toContain("The Atlas");
  });

  it("extracts the identifiers the graph can traverse", () => {
    const entities = extractMemoryEntities(
      "Acme Corp escalated ACME-1420 to Priya after the billing-api deploy. Ping @priya or ops@acme.test. #renewal",
    );
    const keys = entities.map((entity) => entity.key);
    expect(keys).toContain("acme corp");
    expect(keys).toContain("priya");
    expect(keys).toContain("acme-1420");
    expect(keys).toContain("billing-api");
    expect(keys).toContain("priya");
    expect(keys).toContain("ops@acme.test");
    expect(keys).toContain("renewal");
    expect(entities.find((entity) => entity.key === "priya")).toMatchObject({
      name: "@priya",
      type: "handle",
    });
    expect(entities.find((entity) => entity.key === "renewal")).toMatchObject({
      name: "#renewal",
      type: "tag",
    });
  });

  it("deduplicates by normalized key and keeps the specific type", () => {
    const entities = extractMemoryEntities("Acme acme ACME");
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({ key: "acme", type: "proper" });
  });

  it("drops stopwords and enforces the limit", () => {
    const entities = extractMemoryEntities("the and please remember this", 10);
    expect(entities).toEqual([]);
    const many = extractMemoryEntities(
      Array.from({ length: 80 }, (_, index) => `Topic${index} alpha${index}`).join(" "),
      12,
    );
    expect(many).toHaveLength(12);
  });

  it("tokenizes for lexical scoring without stopwords", () => {
    expect(tokenizeForSearch("The renewal is owned by Priya")).toEqual([
      "renewal",
      "owned",
      "priya",
    ]);
  });
});

describe("graph identity", () => {
  it("builds stable, replay-safe memory ids", () => {
    const base = {
      spaceId: "space-1",
      scope: "isolated" as const,
      botId: "bot-1",
      kind: "durable" as const,
      text: "Acme renewal",
    };
    expect(memoryNodeId(base)).toBe(memoryNodeId({ ...base }));
    expect(memoryNodeId(base)).toMatch(/^m_[a-f0-9]{24}$/);
    expect(memoryNodeId(base)).not.toBe(memoryNodeId({ ...base, text: "Other" }));
    expect(memoryNodeId(base)).not.toBe(memoryNodeId({ ...base, botId: "bot-2" }));
    expect(memoryNodeId(base)).not.toBe(memoryNodeId({ ...base, scope: "shared" }));
    expect(memoryNodeId({ ...base, kind: "history", generation: 2 })).toMatch(/^h_/);
    expect(memoryNodeId({ ...base, kind: "history", generation: 2 })).not.toBe(
      memoryNodeId({ ...base, kind: "history", generation: 3 }),
    );
  });

  it("derives one graph per Space with a sanitized namespace", () => {
    expect(sanitizeGraphNamespace("Prod Brain!")).toBe("prod_brain");
    expect(sanitizeGraphNamespace("")).toBe("rakazo");
    const name = spaceGraphName("Prod Brain!", "space-1");
    expect(name).toMatch(/^prod_brain_space_[a-f0-9]{24}$/);
    expect(spaceGraphName("Prod Brain!", "space-1")).toBe(name);
    expect(spaceGraphName("Prod Brain!", "space-2")).not.toBe(name);
    expect(spaceGraphName("other", "space-1")).not.toBe(name);
  });
});

describe("saveMemory", () => {
  it("writes the memory, entity edges and episodic link", async () => {
    const connection = new FakeConnection((call) => {
      if (call.cypher.includes("MATCH (prev:Memory")) return [{ id: "m_prev" }];
      return [{ id: "m_1" }];
    });
    const graph = new FalkorMemoryGraph(connection, {
      graphName: "rakazo_space_test",
      now: () => 1_700_000_000_000,
    });

    await graph.saveMemory({
      id: "m_1",
      text: "Acme renewal is owned by Priya",
      kind: "durable",
      scope: "isolated",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "user-1",
      sourceThreadId: "thread-1",
      entities: extractMemoryEntities("Acme renewal is owned by Priya"),
    });

    const writes = connection.calls.filter((call) => call.kind === "query");
    const first = writes[0];
    expect(first?.cypher).toContain("MERGE (m:Memory {id: $id})");
    expect(first?.cypher).toContain("MERGE (b)-[:REMEMBERS]->(m)");
    expect(first?.params).toMatchObject({
      spaceId: "space-1",
      botId: "bot-1",
      userId: "user-1",
      kind: "durable",
      scope: "isolated",
    });

    const entityWrite = writes.find((call) => call.cypher.includes("CO_OCCURS"));
    expect(entityWrite?.cypher).toContain("MERGE (m)-[r:MENTIONS]->(e)");
    const writtenEntities = entityWrite?.params?.entities;
    expect(Array.isArray(writtenEntities) ? writtenEntities.length : 0).toBeGreaterThan(0);

    const threadWrite = writes.find((call) => call.cypher.includes("SOURCED_FROM"));
    expect(threadWrite?.params).toMatchObject({ threadId: "thread-1" });

    const chainWrite = writes.find((call) => call.cypher.includes("MERGE (prev)-[:NEXT]->(m)"));
    expect(chainWrite?.params).toMatchObject({ previousId: "m_prev", id: "m_1" });
  });

  it("skips optional writes when there is nothing to link", async () => {
    const connection = new FakeConnection(() => [{ id: "m_1" }]);
    const graph = new FalkorMemoryGraph(connection, { graphName: "g" });
    await graph.saveMemory({
      id: "m_1",
      text: "hello",
      kind: "durable",
      scope: "isolated",
      spaceId: "space-1",
      botId: "bot-1",
      userId: "user-1",
      entities: [],
    });
    expect(connection.calls.some((call) => call.cypher.includes("MENTIONS"))).toBe(false);
    expect(connection.calls.some((call) => call.cypher.includes("SOURCED_FROM"))).toBe(false);
  });
});

describe("recallMemories", () => {
  function recallConnection() {
    return new FakeConnection((call) => {
      if (call.cypher.includes("n.key AS key")) {
        return [{ key: "billing", weight: 4 }];
      }
      if (call.cypher.includes("seed.key IN $keys")) {
        return [memoryRow({ id: "m_seed", entities: ["acme"] })];
      }
      if (call.cypher.includes("e.key IN $keys") && call.cypher.includes("all")) {
        return [];
      }
      if (call.cypher.includes("e.key IN $keys")) {
        return [
          memoryRow({
            id: "m_hop",
            text: "Billing-api incident review",
            entities: ["billing"],
            updatedAt: 1_700_000_000_000 - 86_400_000,
          }),
        ];
      }
      return [memoryRow({ id: "m_recent", text: "Unrelated standup notes", entities: [] })];
    });
  }

  it("ranks direct entity matches and shows the multi-hop trail", async () => {
    const connection = recallConnection("isolated");
    const graph = new FalkorMemoryGraph(connection, {
      graphName: "rakazo_space_test",
      now: () => 1_700_000_000_000,
    });

    const results = await graph.recallMemories({
      spaceId: "space-1",
      botId: "bot-1",
      userId: "user-1",
      scope: "isolated",
      query: "What is happening with Acme?",
      limit: 5,
      maxHops: 2,
    });

    expect(results[0]).toMatchObject({ id: "m_seed", entity: "bot:bot-1" });
    expect(results.some((result) => result.id === "m_hop")).toBe(true);
    expect(results[0]?.provenance).toContain("direct: acme");
    const hopResult = results.find((result) => result.id === "m_hop");
    expect(hopResult?.provenance).toContain("1-hop: billing");
    expect(results.some((result) => result.id === "m_recent")).toBe(false);
    expect(results[0]?.score).toBeGreaterThan(0);
  });

  it("always constrains recall to the current tenant and scope", async () => {
    const isolated = recallConnection();
    await new FalkorMemoryGraph(isolated, { graphName: "g" }).recallMemories({
      spaceId: "space-1",
      botId: "bot-1",
      userId: "user-1",
      scope: "isolated",
      query: "Acme",
      limit: 5,
    });
    for (const call of isolated.calls) {
      if (!call.cypher.includes("MATCH (m:Memory")) continue;
      expect(call.cypher).toContain("m.expired = false");
      expect(call.cypher).toContain("m.botId = $botId");
      expect(call.params).toMatchObject({ botId: "bot-1", spaceId: "space-1" });
    }

    const shared = recallConnection();
    await new FalkorMemoryGraph(shared, { graphName: "g" }).recallMemories({
      spaceId: "space-1",
      botId: "bot-1",
      userId: "user-1",
      scope: "shared",
      query: "Acme",
      limit: 5,
    });
    const scoped = shared.calls.find((call) => call.cypher.includes("m.scope = 'shared'"));
    expect(scoped).toBeDefined();
    expect(scoped?.cypher).toContain("m.spaceId = $spaceId");
  });

  it("includes history summaries only for the requested generation", async () => {
    const connection = new FakeConnection(() => []);
    await new FalkorMemoryGraph(connection, { graphName: "g" }).recallMemories({
      spaceId: "space-1",
      botId: "bot-1",
      userId: "user-1",
      scope: "isolated",
      query: "Acme",
      limit: 3,
      historyGeneration: 7,
    });
    expect(connection.calls[0]?.cypher).toContain("m.generation = $generation");
    expect(connection.calls[0]?.params).toMatchObject({ generation: 7 });
  });

  it("returns nothing for an empty graph", async () => {
    const graph = new FalkorMemoryGraph(new FakeConnection(), { graphName: "g" });
    await expect(
      graph.recallMemories({
        spaceId: "space-1",
        botId: "bot-1",
        userId: "user-1",
        scope: "isolated",
        query: "anything",
        limit: 5,
      }),
    ).resolves.toEqual([]);
  });
});

describe("forget and purge", () => {
  it("soft-deletes a memory inside the tenant boundary", async () => {
    const connection = new FakeConnection(() => [{ id: "m_1" }]);
    const graph = new FalkorMemoryGraph(connection, { graphName: "g", now: () => 42 });
    await expect(
      graph.forgetMemory({ memoryId: "m_1", spaceId: "space-1", botId: "bot-1", reason: "stale" }),
    ).resolves.toEqual({ expired: true });
    const call = connection.calls[0];
    expect(call?.cypher).toContain("SET m.expired = true");
    expect(call?.cypher).toContain("m.spaceId = $spaceId");
    expect(call?.params).toMatchObject({ reason: "stale", now: 42 });
  });

  it("reports a miss instead of claiming a delete", async () => {
    const graph = new FalkorMemoryGraph(new FakeConnection(() => []), { graphName: "g" });
    await expect(
      graph.forgetMemory({ memoryId: "missing", spaceId: "space-1", botId: "bot-1" }),
    ).resolves.toEqual({ expired: false });
  });

  it("purges only the requested history generations", async () => {
    const connection = new FakeConnection();
    const graph = new FalkorMemoryGraph(connection, { graphName: "g" });
    await graph.purgeHistory({ botId: "bot-1", generations: [3, 3, 4] });
    expect(connection.calls[0]?.cypher).toContain("DETACH DELETE m");
    expect(connection.calls[0]?.params).toMatchObject({ botId: "bot-1", generations: [3, 4] });
    await graph.purgeHistory({ botId: "bot-1", generations: [] });
    expect(connection.calls).toHaveLength(1);
  });
});

describe("read-only graph queries", () => {
  it("keeps string literals while appending the row cap", async () => {
    const connection = new FakeConnection(() => [{ key: "acme" }]);
    const graph = new FalkorMemoryGraph(connection, { graphName: "g" });
    await graph.runReadOnlyQuery("MATCH (e:Entity {key: 'acme'}) RETURN e.key AS key", 5);
    expect(connection.calls[0]?.cypher).toBe(
      "MATCH (e:Entity {key: 'acme'}) RETURN e.key AS key\nLIMIT 5",
    );
  });

  it("runs through the read-only command and caps rows", async () => {
    const connection = new FakeConnection(() => [
      { label: "Memory", count: 4 },
      { label: "Entity", count: 9 },
    ]);
    const graph = new FalkorMemoryGraph(connection, { graphName: "g" });
    const result = await graph.runReadOnlyQuery(
      "MATCH (n) RETURN labels(n)[0] AS label, count(*) AS count",
      1,
    );
    expect(connection.calls[0]?.kind).toBe("roQuery");
    expect(connection.calls[0]?.cypher).toContain("LIMIT 1");
    expect(result).toMatchObject({
      columns: ["label", "count"],
      truncated: true,
      graph: "g",
    });
    expect(result.rows).toHaveLength(1);
  });

  it.each([
    "CREATE (n:Memory)",
    "MATCH (n) DETACH DELETE n",
    "MATCH (n) SET n.expired = true RETURN n",
    "CALL db.labels()",
    "MATCH (n) RETURN n; MATCH (m) RETURN m",
    "MERGE (n:Entity {key: 'x'})",
  ])("rejects a write: %s", (cypher) => {
    expect(() => assertReadOnlyCypher(cypher)).toThrow();
  });

  it.each([
    "MATCH (n) RETURN n",
    "MATCH (m:Memory)-[:MENTIONS]->(e:Entity) RETURN e.key AS key, count(*) AS count",
    "OPTIONAL MATCH (n) RETURN n",
    "WITH 1 AS one RETURN one",
    "RETURN 1 AS ok",
    "MATCH (n) RETURN n LIMIT 10;",
  ])("allows a read: %s", (cypher) => {
    expect(() => assertReadOnlyCypher(cypher)).not.toThrow();
  });

  it("does not treat string literals or comments as clauses", () => {
    expect(() =>
      assertReadOnlyCypher("MATCH (n) WHERE n.text = 'delete me' RETURN n"),
    ).not.toThrow();
    expect(() => assertReadOnlyCypher("MATCH (n) // create later\nRETURN n")).not.toThrow();
    expect(() => assertReadOnlyCypher("MATCH (n) WHERE n.text = 'it\\'s' RETURN n")).not.toThrow();
  });
});
