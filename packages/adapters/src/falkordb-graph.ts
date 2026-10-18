import { createHash } from "node:crypto";

/**
 * Graph-native durable memory for Rakazo, stored in FalkorDB.
 *
 * The graph is the retrieval structure, not a side store:
 *
 *   (:Space {id})-[:IN_SPACE]-(:Memory {id, text, kind, scope, ...})
 *   (:Bot {id})-[:REMEMBERS]->(:Memory)
 *   (:User {id})-[:SAVED]->(:Memory)
 *   (:Memory)-[:MENTIONS {count}]->(:Entity {key, name, type})
 *   (:Entity)-[:CO_OCCURS {weight}]-(:Entity)
 *   (:Memory)-[:NEXT]->(:Memory)                     // episodic chain
 *   (:Memory)-[:SOURCED_FROM]->(:Thread {id})        // decision provenance
 *
 * Each Space gets its own FalkorDB graph so tenant separation is enforced by the
 * storage boundary, not only by a WHERE clause.
 */

export type FalkorRow = Record<string, unknown>;

/** Values the FalkorDB client can inline as Cypher parameters. */
export type FalkorParamValue =
  | string
  | number
  | boolean
  | null
  | FalkorParamValue[]
  | { [key: string]: FalkorParamValue };

export type FalkorParams = Record<string, FalkorParamValue>;

/** The subset of the FalkorDB client the memory graph needs. Test doubles implement this. */
export interface FalkorGraphConnection {
  query(cypher: string, params?: FalkorParams): Promise<FalkorRow[]>;
  roQuery(cypher: string, params?: FalkorParams): Promise<FalkorRow[]>;
}

export type MemoryEntityType =
  | "url"
  | "email"
  | "id"
  | "handle"
  | "tag"
  | "phrase"
  | "proper"
  | "code"
  | "term";

export interface MemoryEntity {
  key: string;
  name: string;
  type: MemoryEntityType;
}

export type MemoryKind = "durable" | "history";
export type MemoryScope = "isolated" | "shared";

export interface SaveMemoryGraphInput {
  id: string;
  text: string;
  kind: MemoryKind;
  scope: MemoryScope;
  spaceId: string;
  botId: string;
  userId: string;
  generation?: number;
  sourceRunId?: string;
  sourceThreadId?: string;
  entities: MemoryEntity[];
}

export interface RecallMemoryGraphInput {
  spaceId: string;
  botId: string;
  userId: string;
  scope: MemoryScope;
  query: string;
  limit: number;
  /** When set, history summaries saved for this compaction generation are recalled too. */
  historyGeneration?: number;
  maxHops?: number;
}

export interface GraphRecalledMemory {
  id: string;
  text: string;
  scope: MemoryScope;
  kind: MemoryKind;
  botId: string;
  updatedAt: string;
  score: number;
  entities: string[];
  /** Human-readable trail of how the graph produced this memory. */
  provenance: string;
  entity: string;
}

export interface ForgetMemoryGraphInput {
  memoryId: string;
  spaceId: string;
  botId: string;
  reason?: string;
}

export interface ReadOnlyGraphQueryResult {
  columns: string[];
  rows: FalkorRow[];
  truncated: boolean;
  graph: string;
}

/** English function words that carry no retrieval signal. */
const STOPWORDS = new Set([
  "a",
  "about",
  "after",
  "again",
  "against",
  "all",
  "also",
  "am",
  "among",
  "an",
  "and",
  "another",
  "any",
  "anything",
  "are",
  "as",
  "at",
  "be",
  "because",
  "been",
  "before",
  "being",
  "between",
  "both",
  "but",
  "by",
  "came",
  "can",
  "cannot",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "done",
  "down",
  "during",
  "each",
  "either",
  "else",
  "even",
  "ever",
  "every",
  "for",
  "from",
  "further",
  "give",
  "goes",
  "going",
  "gone",
  "had",
  "has",
  "have",
  "having",
  "he",
  "her",
  "here",
  "hers",
  "herself",
  "him",
  "himself",
  "his",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "itself",
  "just",
  "keep",
  "know",
  "known",
  "last",
  "less",
  "like",
  "made",
  "make",
  "many",
  "may",
  "me",
  "might",
  "more",
  "most",
  "much",
  "must",
  "my",
  "myself",
  "never",
  "next",
  "no",
  "none",
  "not",
  "nothing",
  "of",
  "often",
  "on",
  "once",
  "only",
  "or",
  "other",
  "others",
  "ought",
  "our",
  "out",
  "over",
  "perhaps",
  "please",
  "quite",
  "rather",
  "really",
  "said",
  "same",
  "says",
  "shall",
  "she",
  "should",
  "since",
  "so",
  "some",
  "still",
  "such",
  "than",
  "that",
  "the",
  "their",
  "theirs",
  "them",
  "themselves",
  "then",
  "there",
  "these",
  "they",
  "thing",
  "things",
  "this",
  "those",
  "though",
  "through",
  "thus",
  "to",
  "under",
  "until",
  "up",
  "upon",
  "us",
  "very",
  "want",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "whether",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "within",
  "without",
  "would",
  "you",
  "your",
  "yours",
  "yourself",
  "remember",
  "memory",
  "note",
  "notes",
  "user",
  "assistant",
  "bot",
  "remind",
]);

const MAX_ENTITY_NAME_CHARS = 80;
const MAX_ENTITY_KEY_CHARS = 80;

/** Collapse case, spacing and wrapping punctuation so "Acme Corp." and "acme corp" meet. */
export function normalizeEntityKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, "")
    .slice(0, MAX_ENTITY_KEY_CHARS);
}

function pushEntity(found: Map<string, MemoryEntity>, name: string, type: MemoryEntityType): void {
  const trimmed = name
    .replace(/^[\s"'`([{<]+|[\s"'`)\]}>.,;:!?]+$/g, "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .trim();
  if (trimmed.length < 2 || trimmed.length > MAX_ENTITY_NAME_CHARS) return;
  const key = normalizeEntityKey(trimmed);
  if (key.length < 2) return;
  if (
    STOPWORDS.has(key) &&
    type !== "phrase" &&
    type !== "url" &&
    type !== "email" &&
    type !== "id"
  ) {
    return;
  }
  const existing = found.get(key);
  // Keep the more specific classification when the same key appears twice.
  if (existing && entityTypeRank(existing.type) >= entityTypeRank(type)) return;
  found.set(key, { key, name: trimmed, type });
}

function entityTypeRank(type: MemoryEntityType): number {
  switch (type) {
    case "url":
      return 9;
    case "email":
      return 8;
    case "id":
      return 7;
    case "handle":
    case "tag":
      return 6;
    case "phrase":
      return 5;
    case "proper":
      return 4;
    case "code":
      return 3;
    case "term":
      return 1;
  }
}

/**
 * Deterministic offline entity extraction. No model call: memory writes must never
 * wait on (or pay for) an LLM, and the same text must always produce the same graph.
 */
export function extractMemoryEntities(text: string, limit = 40): MemoryEntity[] {
  const found = new Map<string, MemoryEntity>();
  const scan = text.slice(0, 12_000);

  for (const match of scan.matchAll(/\bhttps?:\/\/[^\s<>"')]+/gi)) {
    pushEntity(found, match[0].replace(/[.,;:!?]+$/, ""), "url");
  }
  for (const match of scan.matchAll(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g)) {
    pushEntity(found, match[0], "email");
  }
  for (const match of scan.matchAll(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g)) {
    pushEntity(found, match[0], "id");
  }
  for (const match of scan.matchAll(/(^|[\s(])@([a-z0-9_]{2,32})\b/gi)) {
    pushEntity(found, `@${match[2]}`, "handle");
  }
  for (const match of scan.matchAll(/(^|[\s(])#([a-z0-9_]{2,40})\b/gi)) {
    pushEntity(found, `#${match[2]}`, "tag");
  }
  for (const match of scan.matchAll(/"([^"\n]{2,60})"/g)) {
    pushEntity(found, match[1] ?? "", "phrase");
  }
  for (const match of scan.matchAll(/[“]([^”\n]{2,60})[”]/g)) {
    pushEntity(found, match[1] ?? "", "phrase");
  }
  // Capitalised runs: "Northwind Robotics", "Acme", "Project Atlas".
  for (const match of scan.matchAll(
    /\b[A-Z][A-Za-z0-9]*(?:\s+(?:of|the|and|for)\s+[A-Z][A-Za-z0-9]*|\s+[A-Z][A-Za-z0-9]*){0,3}\b/g,
  )) {
    pushEntity(found, match[0], "proper");
  }
  // Technical identifiers: camelCase, snake_case, dotted paths and file names.
  for (const match of scan.matchAll(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g)) {
    pushEntity(found, match[0], "code");
  }
  for (const match of scan.matchAll(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g)) {
    pushEntity(found, match[0], "code");
  }
  for (const match of scan.matchAll(
    /\b[a-z0-9-]+\.(?:ts|tsx|js|jsx|py|go|rs|rb|java|md|json|yaml|yml|toml|sql|sh)\b/g,
  )) {
    pushEntity(found, match[0], "code");
  }
  // Remaining lowercase content words keep prose topics traversable.
  for (const match of scan.toLowerCase().matchAll(/\b[a-z][a-z0-9'’_-]{3,31}\b/g)) {
    if (STOPWORDS.has(match[0])) continue;
    pushEntity(found, match[0], "term");
  }

  return [...found.values()].slice(0, limit);
}

/** Query terms used for lexical scoring. Kept separate from entity extraction. */
export function tokenizeForSearch(text: string, limit = 64): string[] {
  const tokens = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/\b[a-z][a-z0-9'’_-]{2,31}\b/g)) {
    const token = match[0];
    if (STOPWORDS.has(token)) continue;
    tokens.add(token);
    if (tokens.size >= limit) break;
  }
  return [...tokens];
}

/** Stable id: replaying the same save never duplicates a node. */
export function memoryNodeId(input: {
  spaceId: string;
  scope: MemoryScope;
  botId: string;
  kind: MemoryKind;
  generation?: number;
  text: string;
}): string {
  const normalized = input.text.trim().replace(/\s+/g, " ");
  const digest = createHash("sha256")
    .update(
      [
        input.spaceId,
        input.scope,
        input.botId,
        input.kind,
        input.generation ?? "",
        normalized,
      ].join("\u0000"),
    )
    .digest("hex");
  return `${input.kind === "history" ? "h" : "m"}_${digest.slice(0, 24)}`;
}

/** Graph names are Redis keys: keep them short, lowercase and namespaced per Space. */
export function sanitizeGraphNamespace(namespace: string | undefined): string {
  const cleaned = (namespace ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return cleaned || "rakazo";
}

export function spaceGraphName(namespace: string | undefined, spaceId: string): string {
  const digest = createHash("sha256").update(spaceId).digest("hex").slice(0, 24);
  return `${sanitizeGraphNamespace(namespace)}_space_${digest}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

interface MemoryRow {
  id: string;
  text: string;
  kind: MemoryKind;
  scope: MemoryScope;
  botId: string;
  createdAt: number;
  updatedAt: number;
  entities: string[];
}

function memoryRow(row: FalkorRow): MemoryRow | null {
  const id = asString(row.id);
  const text = asString(row.text);
  if (!id || !text) return null;
  return {
    id,
    text,
    kind: row.kind === "history" ? "history" : "durable",
    scope: row.scope === "shared" ? "shared" : "isolated",
    botId: asString(row.botId) ?? "",
    createdAt: asNumber(row.createdAt) ?? 0,
    updatedAt: asNumber(row.updatedAt) ?? asNumber(row.createdAt) ?? 0,
    entities: asStringList(row.entities),
  };
}

const MEMORY_RETURN = `
  RETURN m.id AS id, m.text AS text, m.kind AS kind, m.scope AS scope,
         m.botId AS botId, m.createdAt AS createdAt, m.updatedAt AS updatedAt,
         collect(DISTINCT e.key) AS entities
  ORDER BY updatedAt DESC`;

export class FalkorMemoryGraph {
  constructor(
    private readonly connection: FalkorGraphConnection,
    private readonly options: { graphName: string; now?: () => number },
  ) {}

  get graphName(): string {
    return this.options.graphName;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private scopeFilter(scope: MemoryScope): string {
    return scope === "shared"
      ? "(m.scope = 'shared' AND m.spaceId = $spaceId) OR (m.scope = 'isolated' AND m.botId = $botId)"
      : "m.scope = 'isolated' AND m.botId = $botId";
  }

  private kindFilter(historyGeneration: number | undefined): string {
    return historyGeneration === undefined
      ? "m.kind = 'durable'"
      : "(m.kind = 'durable' OR (m.kind = 'history' AND m.generation = $generation))";
  }

  async ensureSpace(spaceId: string): Promise<void> {
    await this.connection.query(
      `MERGE (s:Space {id: $spaceId})
       ON CREATE SET s.createdAt = $now
       SET s.updatedAt = $now
       RETURN s.id AS id`,
      { spaceId, now: this.now() },
    );
  }

  /**
   * Upsert one memory plus its entity edges and episodic chain links.
   * Every statement is idempotent (MERGE), so a retry after a partial failure converges.
   */
  async saveMemory(input: SaveMemoryGraphInput): Promise<{ id: string }> {
    await this.connection.query(
      `MERGE (s:Space {id: $spaceId})
       ON CREATE SET s.createdAt = $now
       SET s.updatedAt = $now
       MERGE (b:Bot {id: $botId})
       MERGE (u:User {id: $userId})
       MERGE (m:Memory {id: $id})
       ON CREATE SET m.createdAt = $now, m.recallCount = 0
       ON MATCH SET m.updatedAt = $now
       SET m.text = $text,
           m.kind = $kind,
           m.scope = $scope,
           m.botId = $botId,
           m.userId = $userId,
           m.spaceId = $spaceId,
           m.generation = $generation,
           m.sourceRunId = $sourceRunId,
           m.sourceThreadId = $sourceThreadId,
           m.expired = false
       MERGE (m)-[:IN_SPACE]->(s)
       MERGE (b)-[:REMEMBERS]->(m)
       MERGE (u)-[:SAVED]->(m)
       RETURN m.id AS id`,
      {
        spaceId: input.spaceId,
        botId: input.botId,
        userId: input.userId,
        id: input.id,
        text: input.text,
        kind: input.kind,
        scope: input.scope,
        generation: input.generation ?? null,
        sourceRunId: input.sourceRunId ?? null,
        sourceThreadId: input.sourceThreadId ?? null,
        now: this.now(),
      },
    );

    if (input.entities.length > 0) {
      const entities = input.entities.slice(0, 48).map((entity) => ({
        key: entity.key,
        name: entity.name,
        type: entity.type,
      }));
      await this.connection.query(
        `MATCH (m:Memory {id: $id})
         UNWIND $entities AS ent
         MERGE (e:Entity {key: ent.key})
         ON CREATE SET e.createdAt = $now, e.name = ent.name, e.type = ent.type
         SET e.lastSeenAt = $now
         MERGE (m)-[r:MENTIONS]->(e)
         ON CREATE SET r.count = 1
         ON MATCH SET r.count = r.count + 1
         WITH collect(DISTINCT e) AS entities
         UNWIND entities AS a
         UNWIND entities AS b
         WITH a, b
         WHERE a.key < b.key
         MERGE (a)-[c:CO_OCCURS]->(b)
         ON CREATE SET c.weight = 1, c.updatedAt = $now
         ON MATCH SET c.weight = c.weight + 1, c.updatedAt = $now
         RETURN count(c) AS pairs`,
        { id: input.id, entities, now: this.now() },
      );
    }

    if (input.sourceThreadId) {
      await this.connection.query(
        `MATCH (m:Memory {id: $id})
         MERGE (t:Thread {id: $threadId})
         ON CREATE SET t.createdAt = $now
         MERGE (m)-[:SOURCED_FROM]->(t)`,
        { id: input.id, threadId: input.sourceThreadId, now: this.now() },
      );
    }

    // Episodic chain: link this memory after the previous one for the same scope.
    const previous = await this.connection.query(
      `MATCH (prev:Memory {botId: $botId, scope: $scope, kind: $kind})
       WHERE prev.id <> $id AND prev.createdAt <= $now
       RETURN prev.id AS id
       ORDER BY prev.createdAt DESC, prev.id DESC
       LIMIT 1`,
      {
        botId: input.botId,
        scope: input.scope,
        kind: input.kind,
        id: input.id,
        now: this.now() + 1,
      },
    );
    const previousId = asString(previous[0]?.id);
    if (previousId && previousId !== input.id) {
      await this.connection.query(
        `MATCH (prev:Memory {id: $previousId}), (m:Memory {id: $id})
         MERGE (prev)-[:NEXT]->(m)`,
        { previousId, id: input.id },
      );
    }

    return { id: input.id };
  }

  async recallMemories(input: RecallMemoryGraphInput): Promise<GraphRecalledMemory[]> {
    const now = this.now();
    const seedKeys = [...new Set(extractMemoryEntities(input.query, 24).map((e) => e.key))];
    const queryTerms = tokenizeForSearch(input.query);
    const kindFilter = this.kindFilter(input.historyGeneration);
    const scopeFilter = this.scopeFilter(input.scope);
    const baseParams = {
      spaceId: input.spaceId,
      botId: input.botId,
      generation: input.historyGeneration ?? null,
      scan: Math.min(200, Math.max(60, input.limit * 12)),
    };
    const maxHops = Math.max(0, Math.min(3, input.maxHops ?? 2));

    const recentMemoryQuery = `
      MATCH (m:Memory)
      WHERE ${kindFilter}
        AND m.expired = false
        AND (${scopeFilter})
      WITH m
      ORDER BY m.updatedAt DESC
      LIMIT $limit
      OPTIONAL MATCH (m)-[:MENTIONS]->(e:Entity)
      ${MEMORY_RETURN}`;

    const [seedRows, recentRows] = await Promise.all([
      seedKeys.length > 0
        ? this.connection.query(
            `MATCH (m:Memory)-[:MENTIONS]->(seed:Entity)
             WHERE seed.key IN $keys
               AND ${kindFilter}
               AND m.expired = false
               AND (${scopeFilter})
             WITH m
             ORDER BY m.updatedAt DESC
             LIMIT $limit
             OPTIONAL MATCH (m)-[:MENTIONS]->(e:Entity)
             ${MEMORY_RETURN}`,
            {
              ...baseParams,
              keys: seedKeys,
              limit: Math.min(160, Math.max(24, input.limit * 8)),
            },
          )
        : Promise.resolve([]),
      this.connection.query(recentMemoryQuery, {
        ...baseParams,
        limit: baseParams.scan,
      }),
    ]);

    // Multi-hop expansion: co-occurrence neighbours up to maxHops.
    const hopByKey = new Map<string, { hop: number; weight: number }>();
    const seen = new Set(seedKeys);
    let frontier = seedKeys;
    for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
      const rows = await this.connection.query(
        `MATCH (seed:Entity)-[c:CO_OCCURS]-(n:Entity)
         WHERE seed.key IN $keys AND NOT (n.key IN $seen)
         RETURN n.key AS key, sum(c.weight) AS weight
         ORDER BY weight DESC
         LIMIT $limit`,
        { keys: frontier, seen: [...seen], limit: hop === 1 ? 16 : 8 },
      );
      const next: string[] = [];
      for (const row of rows) {
        const key = asString(row.key);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        hopByKey.set(key, { hop, weight: Math.max(1, asNumber(row.weight) ?? 1) });
        next.push(key);
      }
      frontier = next;
    }

    const hopRows =
      hopByKey.size > 0
        ? await this.connection.query(
            `MATCH (m:Memory)-[:MENTIONS]->(e:Entity)
             WHERE e.key IN $keys
               AND ${kindFilter}
               AND m.expired = false
               AND (${scopeFilter})
             WITH m
             ORDER BY m.updatedAt DESC
             LIMIT $limit
             OPTIONAL MATCH (m)-[:MENTIONS]->(e:Entity)
             ${MEMORY_RETURN}`,
            {
              ...baseParams,
              keys: [...hopByKey.keys()],
              limit: Math.min(120, Math.max(24, input.limit * 6)),
            },
          )
        : [];

    const candidates = new Map<string, MemoryRow>();
    for (const row of [...seedRows, ...recentRows, ...hopRows]) {
      const memory = memoryRow(row);
      if (memory) candidates.set(memory.id, memory);
    }
    if (candidates.size === 0) return [];

    const seedSet = new Set(seedKeys);
    const scored = [...candidates.values()].map((memory) => {
      const terms = new Set(tokenizeForSearch(memory.text));
      const matchedTerms = queryTerms.filter((term) => terms.has(term));
      const lexical = queryTerms.length > 0 ? matchedTerms.length / queryTerms.length : 0;
      const matchedDirect: string[] = [];
      const matchedHops: Array<{ key: string; hop: number; weight: number }> = [];
      let entityScore = 0;
      for (const key of memory.entities) {
        if (seedSet.has(key)) {
          entityScore += 1;
          matchedDirect.push(key);
          continue;
        }
        const hop = hopByKey.get(key);
        if (!hop) continue;
        entityScore += (1 / hop.hop) * Math.min(1, Math.log1p(hop.weight) / Math.log1p(8));
        matchedHops.push({ key, ...hop });
      }
      entityScore = Math.min(1, entityScore / 2);
      const ageDays = Math.max(0, (now - memory.updatedAt) / 86_400_000);
      const recency = Math.exp(-ageDays / 45);
      const exactPhrase =
        input.query.trim().length > 2 &&
        memory.text.toLowerCase().includes(input.query.trim().toLowerCase());
      const score = Math.min(
        1,
        0.6 * lexical + 0.28 * entityScore + 0.12 * recency + (exactPhrase ? 0.1 : 0),
      );
      return { memory, matchedTerms, matchedDirect, matchedHops, lexical, entityScore, score };
    });

    return scored
      .filter((entry) => entry.lexical > 0 || entry.entityScore > 0 || entry.score >= 0.25)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.memory.updatedAt - left.memory.updatedAt ||
          left.memory.id.localeCompare(right.memory.id),
      )
      .slice(0, input.limit)
      .map((entry) => {
        const provenance = [
          entry.matchedDirect.length > 0
            ? `direct: ${entry.matchedDirect.slice(0, 3).join(", ")}`
            : null,
          entry.matchedHops.length > 0
            ? entry.matchedHops
                .slice(0, 3)
                .map((hop) => `${hop.hop}-hop: ${hop.key} (w=${hop.weight})`)
                .join(", ")
            : null,
          entry.matchedTerms.length > 0 && queryTerms.length > 0
            ? `terms ${entry.matchedTerms.length}/${queryTerms.length}`
            : null,
          `saved ${new Date(entry.memory.updatedAt).toISOString().slice(0, 10)}`,
        ]
          .filter((part): part is string => Boolean(part))
          .join(" · ");
        return {
          id: entry.memory.id,
          text: entry.memory.text,
          scope: entry.memory.scope,
          kind: entry.memory.kind,
          botId: entry.memory.botId,
          updatedAt: new Date(entry.memory.updatedAt).toISOString(),
          score: Math.round(entry.score * 1000) / 1000,
          entities: entry.memory.entities.slice(0, 12),
          provenance: `${this.graphName} · ${provenance}`.slice(0, 400),
          entity: `${entry.memory.scope === "shared" ? "space" : "bot"}:${
            entry.memory.scope === "shared" ? input.spaceId : input.botId
          }`,
        };
      });
  }

  async forgetMemory(input: ForgetMemoryGraphInput): Promise<{ expired: boolean }> {
    const rows = await this.connection.query(
      `MATCH (m:Memory {id: $id})
       WHERE m.spaceId = $spaceId AND (m.botId = $botId OR m.scope = 'shared')
       SET m.expired = true, m.expiredAt = $now, m.expireReason = $reason
       RETURN m.id AS id`,
      {
        id: input.memoryId,
        spaceId: input.spaceId,
        botId: input.botId,
        now: this.now(),
        reason: input.reason ?? null,
      },
    );
    return { expired: rows.length > 0 };
  }

  async purgeHistory(input: { botId: string; generations: number[] }): Promise<void> {
    if (input.generations.length === 0) return;
    await this.connection.query(
      `MATCH (m:Memory {kind: 'history', botId: $botId})
       WHERE m.generation IN $generations
       DETACH DELETE m`,
      { botId: input.botId, generations: [...new Set(input.generations)] },
    );
  }

  /** Node and relationship counts for the explainability panel and demo output. */
  async schemaCounts(): Promise<{ labels: FalkorRow[]; relationships: FalkorRow[] }> {
    const [labels, relationships] = await Promise.all([
      this.connection.roQuery(
        `MATCH (n) RETURN labels(n)[0] AS label, count(*) AS count ORDER BY count DESC, label ASC`,
      ),
      this.connection.roQuery(
        `MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS count ORDER BY count DESC, type ASC`,
      ),
    ]);
    return { labels, relationships };
  }

  /**
   * Read-only escape hatch for the agent. Validation happens here and the command
   * itself is GRAPH.RO_QUERY, so a write cannot slip through even if the token
   * scanner misses something.
   */
  async runReadOnlyQuery(cypher: string, limit = 50): Promise<ReadOnlyGraphQueryResult> {
    assertReadOnlyCypher(cypher);
    const capped = Math.max(1, Math.min(100, Math.trunc(limit) || 50));
    const rows = await this.connection.roQuery(ensureLimit(cypher, capped));
    return {
      columns: rows[0] ? Object.keys(rows[0]) : [],
      rows: rows.slice(0, capped),
      truncated: rows.length > capped,
      graph: this.graphName,
    };
  }
}

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------

const READ_ONLY_STARTS = new Set(["match", "optional", "with", "unwind", "return"]);

const FORBIDDEN_CLAUSES = new Set([
  "create",
  "merge",
  "delete",
  "detach",
  "set",
  "remove",
  "drop",
  "alter",
  "copy",
  "call",
  "foreach",
  "load",
  "grant",
  "revoke",
  "index",
  "constraint",
  "periodic",
]);

/** Replace string literals, backticked identifiers and comments with spaces. */
export function stripCypherLiterals(cypher: string): string {
  let output = "";
  let index = 0;
  while (index < cypher.length) {
    const char = cypher[index];
    const next = cypher[index + 1];
    if (char === "/" && next === "/") {
      const end = cypher.indexOf("\n", index);
      index = end === -1 ? cypher.length : end + 1;
      output += " ";
      continue;
    }
    if (char === "/" && next === "*") {
      const end = cypher.indexOf("*/", index + 2);
      index = end === -1 ? cypher.length : end + 2;
      output += " ";
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      index++;
      while (index < cypher.length) {
        if (cypher[index] === "\\") {
          index += 2;
          continue;
        }
        if (cypher[index] === quote) {
          index++;
          break;
        }
        index++;
      }
      output += " ";
      continue;
    }
    output += char;
    index++;
  }
  return output;
}

const MAX_READ_ONLY_CYPHER_CHARS = 2_000;

/** Throws unless the query is a single read-only MATCH/RETURN statement. */
export function assertReadOnlyCypher(cypher: string): void {
  const trimmed = cypher.trim().replace(/;\s*$/, "");
  if (!trimmed) throw new Error("Cypher query is empty.");
  if (trimmed.length > MAX_READ_ONLY_CYPHER_CHARS) {
    throw new Error(`Cypher query is too long (max ${MAX_READ_ONLY_CYPHER_CHARS} characters).`);
  }
  const structural = stripCypherLiterals(trimmed);
  if (structural.includes(";")) {
    throw new Error("Only a single Cypher statement is allowed.");
  }
  const words = structural.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];
  const first = words[0];
  if (!first || !READ_ONLY_STARTS.has(first)) {
    throw new Error(
      "Only read-only queries starting with MATCH, OPTIONAL MATCH, WITH, UNWIND or RETURN are allowed.",
    );
  }
  for (const word of words) {
    if (FORBIDDEN_CLAUSES.has(word)) {
      throw new Error(`Writes are not allowed in memory graph queries (found "${word}").`);
    }
  }
}

function ensureLimit(cypher: string, limit: number): string {
  // Only the guard runs on the stripped text; the executed query must keep its literals.
  const query = cypher.trim().replace(/;+\s*$/, "");
  if (/\blimit\b/i.test(stripCypherLiterals(query))) return query;
  return `${query}\nLIMIT ${limit}`;
}
