# Graph Hacks submission — FalkorDB graph memory for Rakazo

**One line:** Rakazo is a self-hosted AI teammate with persistent memory. This fork adds a
FalkorDB provider that turns that memory into a traversable company graph: recall is a
multi-hop walk, answers carry the path, and the agent can query the graph directly.

- Base project: [Rakazo](https://github.com/elie222/rakazo) (Apache-2.0), imported at
  `b884f436`
- Integration: `packages/adapters/src/falkordb-*.ts`, settings UI, `query_memory_graph`
- Setup and schema: [docs/falkordb.md](../falkordb.md)
- Demo: `FALKORDB_URL=falkordb://localhost:6379 pnpm demo:falkordb`

## Why this is a graph agent, not a graph-backed store

| Question the agent asks | What the graph does |
| --- | --- |
| “What is blocking the Atlas renewal?” | Seeds on `atlas`, expands `CO_OCCURS` to `security review` → `soc` → `billing-api`, and recalls the incident memory that shares no query words. |
| “Who knows about billing-api?” | `(:Bot)-[:REMEMBERS]->(:Memory)-[:MENTIONS]->(:Entity)` — a query the flat file store cannot answer. |
| “Why was this decided?” | `(:Memory)-[:SOURCED_FROM]->(:Thread)` plus the `NEXT` episodic chain. |
| “Which facts did we forget?” | Soft-deleted nodes remain auditable (`expired`, `expiredAt`, `expireReason`). |

The provider is wired into the port Rakazo already calls on **every agent turn**, so the
graph shapes recall even when the model never chooses a tool. `query_memory_graph` adds
the explicit, agent-chosen graph query path.

## Tracks

### Track 02 — Agent Memory and Coordination (primary)

- **Episodic:** `NEXT` chain per bot/scope; conversation summaries stored as
  `kind: "history"` with a compaction `generation`.
- **Semantic:** durable facts as `Memory` nodes with entity edges.
- **Procedural:** bots share the Space graph; `shared` scope facts are visible to every
  bot, `isolated` facts stay with their bot.
- **Persistence across sessions:** memory is in FalkorDB, not the process.
- **Updates over time:** idempotent upserts, co-occurrence weights increase as topics
  recur, `updatedAt` drives recency.
- **High-concurrency reads/writes:** connection pooling, `MERGE`-only writes, no
  read-modify-write cycles; recall is 3–5 bounded queries.
- **Separate memory per tenant:** one FalkorDB graph per Space.

### Track 01 — Agents That Act on Connected Data

- Multi-hop reasoning is the recall algorithm (`maxHops` 1–3).
- The agent gets `query_memory_graph` (read-only Cypher) as a first-class tool; the tool
  description includes the schema so tool selection is grounded.
- Explainability: every recalled memory returns a `provenance` trail with the entity
  hops and weights that produced it.

### Track 03 — Company Brain

The same graph links people (`User`), agents (`Bot`), work threads (`Thread`), decisions
(`Memory` + `SOURCED_FROM`), and topics (`Entity`). The demo seeds a company scenario
(Northwind Robotics: a renewal, a security review, an incident, SOC 2 evidence) and
answers “what is blocking the renewal”, “why did the invoice-worker incident matter”,
and “which bots know about billing-api”.

## 3-minute demo script

1. **0:00 — Frame the problem.** Rakazo bots remember facts in Markdown, but they cannot
   follow relationships. Ask a question whose answer is two hops away.
2. **0:20 — Show the graph.** `pnpm demo:falkordb` prints labels/relationships:
   `Memory`, `Entity`, `Bot`, `User`, `Thread` and
   `MENTIONS`, `CO_OCCURS`, `REMEMBERS`, `NEXT`, `SOURCED_FROM`.
3. **0:45 — Multi-hop recall.** The demo asks *“What is blocking the Atlas renewal?”* and
   prints results with scores and `why: direct: atlas · 1-hop: soc (w=2) · terms 2/3`.
4. **1:30 — Agent-chosen query.** Show `query_memory_graph` in Rakazo returning “which
   bots know about billing-api”, then run a write (`DETACH DELETE`) and show it being
   rejected by both the scanner and `GRAPH.RO_QUERY`.
5. **2:10 — Tenant isolation.** Point out one graph per Space and the `isolated` vs
   `shared` scope filters; show the settings screen where the provider is configured.
6. **2:40 — Evidence.** `112` targeted tests pass, 6 of them against a live FalkorDB
   started with one command; the captured transcript is in `demo-output.txt`.

## How to run

```bash
docker compose -f infra/falkordb/docker-compose.yml up -d
pnpm install
FALKORDB_URL=falkordb://localhost:6379 pnpm demo:falkordb
```

Full app:

```bash
cp .env.example .env            # set the required secrets
docker compose --env-file .env -f infra/compose/docker-compose.yml up --build
```

Settings → Memory → Provider **FalkorDB** → endpoint `falkordb://falkordb:6379`.

## Evidence

| Check | Command | Result |
| --- | --- | --- |
| Graph unit tests | `npx vitest run packages/adapters/src/falkordb-graph.test.ts` | 31 passing |
| Provider unit tests | `npx vitest run packages/adapters/src/falkordb-memory-provider.test.ts` | 24 passing |
| Factory / selection / UI | `npx vitest run packages/adapters/src/memory-provider-factory.test.ts packages/adapters/src/memory-tools.test.ts apps/web/src/pages/memory-providers/falkordb-settings.test.ts` | 19 passing |
| Real server | `FALKORDB_URL=… npx vitest run packages/adapters/src/falkordb-graph.integration.test.ts` | 6 passing (graph + provider paths) |
| Demo | `FALKORDB_URL=… pnpm demo:falkordb` | see `demo-output.txt` |
| Formatting/lint | `npx biome check <changed files>` | clean |

The only failing repo-wide check in this sandbox is the pre-existing dependency on a
generated Prisma client (`pnpm db:generate` needs `binaries.prisma.sh`, unreachable
here); it is unrelated to this change.

## What the graph decides

- **Which memories enter the prompt.** Ranked, provenance-bearing recall — not a recency
  dump.
- **Which tool is available.** `query_memory_graph` is hidden unless the resolved
  provider implements the graph verb.
- **What the agent may write.** `GRAPH.RO_QUERY` plus a clause scanner; writes only via
  the save/forget verbs.
- **What is visible.** Graph per Space, scope filter per bot.

## Roadmap

- Embedding index (`createNodeVectorIndex`) as an additional ranking signal.
- Scheduled co-occurrence decay and memory compaction.
- Cross-Space “company brain” links with explicit grants.
- Pretty graph export for the Settings UI (currently via Cypher over the tool).
