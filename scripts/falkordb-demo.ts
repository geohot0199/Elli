/**
 * FalkorDB graph-memory demo / acceptance script.
 *
 * Usage:
 *   FALKORDB_URL=falkordb://localhost:6379 pnpm demo:falkordb
 *
 * It seeds a small company-brain scenario into one isolated demo graph, then shows
 * the three things the hackathon cares about: multi-hop recall, an explainable
 * traversal trail, and a graph query that answers "who knows what".
 *
 * This talks to a real FalkorDB server. For unit coverage without a server see
 * packages/adapters/src/falkordb-graph.test.ts.
 */
import {
  extractMemoryEntities,
  FalkorMemoryGraph,
  memoryNodeId,
  spaceGraphName,
} from "../packages/adapters/src/falkordb-graph.js";
import {
  createFalkorProvider,
  defaultFalkorConnect,
  FalkorConnectionPool,
} from "../packages/adapters/src/falkordb-memory-provider.js";

const url = process.env.FALKORDB_URL ?? "falkordb://localhost:6379";
const namespace = process.env.FALKORDB_NAMESPACE ?? "rakazo_demo";
const spaceId = "northwind-robotics";
const graphName = spaceGraphName(namespace, spaceId);

const config = {
  url,
  namespace,
  maxHops: 2,
  allowWrites: true,
  timeoutMs: 10_000,
  endpointTrust: "private" as const,
};

type Seed = {
  botId: string;
  userId: string;
  scope: "isolated" | "shared";
  threadId: string;
  text: string;
};

const seeds: Seed[] = [
  {
    botId: "atlas",
    userId: "priya",
    scope: "isolated",
    threadId: "thread-renewal",
    text: "Northwind Robotics renewed the Atlas contract. Priya Raman owns the renewal and the security review.",
  },
  {
    botId: "atlas",
    userId: "priya",
    scope: "isolated",
    threadId: "thread-renewal",
    text: "The Atlas security review is blocked by missing SOC 2 evidence from the billing-api team.",
  },
  {
    botId: "sentinel",
    userId: "marco",
    scope: "shared",
    threadId: "thread-incident",
    text: "Incident INC-2041: a retry storm in invoice-worker hit billing-api during the monthly close.",
  },
  {
    botId: "sentinel",
    userId: "marco",
    scope: "shared",
    threadId: "thread-incident",
    text: "Root cause of INC-2041 was a missing idempotency key in invoice-worker; the fix shipped on 2026-10-02.",
  },
  {
    botId: "atlas",
    userId: "priya",
    scope: "isolated",
    threadId: "thread-renewal",
    text: "Priya Raman decided to sign the renewal with a 30-day security remediation plan for SOC 2.",
  },
  {
    botId: "sentinel",
    userId: "marco",
    scope: "shared",
    threadId: "thread-soc2",
    text: "SOC 2 evidence for billing-api is owned by Marco Silva and lives in the compliance workspace.",
  },
  {
    botId: "atlas",
    userId: "priya",
    scope: "isolated",
    threadId: "thread-renewal",
    text: "Northwind Robotics asked for a weekly status update on the billing-api remediation.",
  },
];

const server = await defaultFalkorConnect(config).catch((error: unknown) => {
  console.error(`\nCould not reach FalkorDB at ${url}.`);
  console.error("Start one with: docker compose -f infra/falkordb/docker-compose.yml up -d");
  const reason =
    error instanceof Error ? error.message || error.name : String(error) || "connection failed";
  console.error(`Or set FALKORDB_URL. (${reason})`);
  process.exit(1);
});
const graph = new FalkorMemoryGraph(server.selectGraph(graphName), { graphName });

function line(title: string) {
  console.log(`\n${title}\n${"─".repeat(title.length)}`);
}

try {
  line(`FalkorDB graph memory demo · ${graphName}`);
  console.log(`Server: ${url}`);
  await server.selectGraph(graphName).query("MATCH (n) DETACH DELETE n");
  console.log("Reset the demo graph.");

  for (const seed of seeds) {
    const id = memoryNodeId({
      spaceId,
      scope: seed.scope,
      botId: seed.botId,
      kind: "durable",
      text: seed.text,
    });
    await graph.saveMemory({
      id,
      text: seed.text,
      kind: "durable",
      scope: seed.scope,
      spaceId,
      botId: seed.botId,
      userId: seed.userId,
      sourceRunId: `seed-${seed.botId}`,
      sourceThreadId: seed.threadId,
      entities: extractMemoryEntities(seed.text),
    });
    console.log(`  + ${seed.botId.padEnd(8)} ${seed.scope.padEnd(8)} ${seed.text.slice(0, 68)}…`);
  }

  const counts = await graph.schemaCounts();
  line("Graph shape");
  for (const row of counts.labels) console.log(`  ${String(row.label).padEnd(10)} ${row.count}`);
  for (const row of counts.relationships) {
    console.log(`  -[${String(row.type)}]-> ${row.count}`);
  }

  const question = "What is blocking the Atlas renewal, and who is involved?";
  line(`Recall: ${question}`);
  const recalled = await graph.recallMemories({
    spaceId,
    botId: "atlas",
    userId: "priya",
    scope: "isolated",
    query: question,
    limit: 5,
    maxHops: 2,
  });
  if (recalled.length === 0) console.log("  (no memories matched)");
  for (const memory of recalled) {
    console.log(`\n  [${memory.score.toFixed(3)}] ${memory.text}`);
    console.log(`          why: ${memory.provenance}`);
    console.log(`          entities: ${memory.entities.join(", ")}`);
  }

  line("Two-hop question the flat store cannot answer");
  const why = await graph.recallMemories({
    spaceId,
    botId: "atlas",
    userId: "priya",
    scope: "isolated",
    query: "Why did the invoice-worker retry storm matter for the renewal?",
    limit: 4,
    maxHops: 2,
  });
  for (const memory of why) {
    console.log(`\n  [${memory.score.toFixed(3)}] ${memory.text}`);
    console.log(`          why: ${memory.provenance}`);
  }

  line("Read-only Cypher: which bots know about billing-api?");
  const who = await graph.runReadOnlyQuery(
    `MATCH (b:Bot)-[:REMEMBERS]->(m:Memory)-[:MENTIONS]->(e:Entity {key: 'billing-api'})
     RETURN b.id AS bot, count(DISTINCT m) AS memories
     ORDER BY memories DESC, bot ASC`,
    10,
  );
  console.table(who.rows);
  console.log(`  graph=${who.graph} truncated=${who.truncated}`);

  line("Read-only Cypher: how do Atlas and SOC 2 connect?");
  const path = await graph.runReadOnlyQuery(
    `MATCH p=(a:Entity {key: 'atlas'})-[*1..4]-(b:Entity {key: 'soc'})
     RETURN [n IN nodes(p) | n.key] AS path, length(p) AS hops
     ORDER BY hops ASC
     LIMIT 3`,
    5,
  );
  console.table(path.rows);

  line("Episodic chain for the shared incident thread");
  const chain = await graph.runReadOnlyQuery(
    `MATCH (t:Thread {id: 'thread-incident'})<-[:SOURCED_FROM]-(m:Memory)
     RETURN m.id AS id, m.text AS text, m.createdAt AS createdAt
     ORDER BY m.createdAt ASC`,
    10,
  );
  console.table(chain.rows);

  // The two calls below are the exact provider entry points the agent's
  // recall_memory and query_memory_graph tools hit at runtime.
  const pool = new FalkorConnectionPool(defaultFalkorConnect);
  const provider = createFalkorProvider(
    { url, namespace, maxHops: "2", allowWrites: "true", timeoutMs: "10000" },
    {},
    { pool },
  );
  const context = {
    operationId: "demo-op",
    traceId: "demo-trace",
    spaceId,
    userId: "priya",
    botId: "atlas",
    threadId: "thread-renewal",
    signal: new AbortController().signal,
  };

  line("Provider recall (the recall_memory tool path)");
  const providerRecall = await provider.recall(
    { query: "What is blocking the Atlas renewal?", scope: "isolated", botId: "atlas", limit: 2 },
    context,
  );
  if (!providerRecall.ok) throw new Error(providerRecall.error);
  for (const memory of providerRecall.value) {
    console.log(`\n  [${memory.score.toFixed(3)}] ${memory.memory}`);
    console.log(`          why: ${memory.provenance}`);
  }

  line("Provider graph query (the query_memory_graph tool path)");
  const providerQuery = await provider.queryGraph?.(
    {
      cypher: `MATCH (u:User)-[:SAVED]->(m:Memory)-[:MENTIONS]->(e:Entity {key: 'soc'})
               RETURN u.id AS user, count(DISTINCT m) AS memories
               ORDER BY memories DESC`,
    },
    context,
  );
  if (!providerQuery?.ok) throw new Error(providerQuery?.error ?? "graph query failed");
  console.table(providerQuery.value.rows);
  await pool.closeAll();

  console.log("\nDemo complete. Both provider calls above are the same code paths the bot");
  console.log("uses for recall_memory and query_memory_graph inside Rakazo.\n");
} finally {
  await server.close();
}
