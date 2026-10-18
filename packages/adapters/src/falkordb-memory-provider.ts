import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type {
  AdapterContext,
  DurableMemoryScope,
  SemanticMemoryProvider,
  SemanticMemoryRecallRequest,
  SemanticMemoryResponse,
  SemanticMemoryResult,
  SemanticMemorySaveRequest,
} from "@rakazo/adapter-kit";
import { isLocalMcpHost } from "@rakazo/contracts";
import { FalkorDB } from "falkordb";
import {
  extractMemoryEntities,
  type FalkorGraphConnection,
  FalkorMemoryGraph,
  type FalkorParams,
  type FalkorRow,
  type GraphRecalledMemory,
  memoryNodeId,
  type ReadOnlyGraphQueryResult,
  spaceGraphName,
} from "./falkordb-graph.js";
import { MemoryProviderDeploymentOwnerRequiredError } from "./memory-provider-error.js";
import {
  isCloudMetadataAddress,
  isPrivateAddress,
  type ResolveHostname,
} from "./network-address.js";
import { isBlockedHostname } from "./web-ssrf.js";

export const FALKORDB_PROVIDER_ID = "falkordb";

const DEFAULT_PORT = 6379;
const DEFAULT_NAMESPACE = "rakazo";
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS = 500;
const MAX_TIMEOUT_MS = 30_000;
const MAX_MEMORY_CHARS = 8_000;
const PROBE_GRAPH = "rakazo_probe";

/**
 * Connection settings for one Space. The provider keeps one TCP connection pool per
 * endpoint and selects a dedicated graph per Space:
 *
 *   <namespace>_space_<sha256(spaceId)[:24]>
 */
export interface FalkorConnectionConfig {
  url: string;
  username?: string;
  password?: string;
  namespace: string;
  maxHops: number;
  allowWrites: boolean;
  timeoutMs: number;
  endpointTrust: "private" | "public";
}

export interface FalkorServer {
  selectGraph(name: string): FalkorGraphConnection;
  close(): Promise<void>;
}

export type FalkorConnect = (config: FalkorConnectionConfig) => Promise<FalkorServer>;

export type FalkorNetworkDependencies = {
  resolveHostname?: ResolveHostname;
};

export interface FalkorPrepareDependencies extends FalkorNetworkDependencies {
  connect?: FalkorConnect;
  /** Tests skip the probe; production always probes. */
  probe?: boolean;
}

function requiredValue(values: Record<string, string>, key: string): string {
  const value = values[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function parseBooleanSetting(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") return defaultValue;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`expected boolean setting, got "${value}"`);
}

function parseIntegerSetting(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

/** Parse without DNS so the owner gate can run before any credentialed work. */
export function parseFalkorUrl(raw: string): URL {
  if (!raw.trim()) throw new Error("FalkorDB URL is required.");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("FalkorDB URL must look like falkordb://host:6379.");
  }
  if (url.protocol !== "falkordb:" && url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("FalkorDB URL must use the falkordb://, redis:// or rediss:// scheme.");
  }
  if (url.username || url.password) {
    throw new Error(
      "FalkorDB credentials belong in the username and password fields, not the URL.",
    );
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("FalkorDB URL must not include a path, query, or fragment.");
  }
  if (!url.hostname) throw new Error("FalkorDB URL must include a host.");
  return url;
}

function normalizeFalkorUrl(raw: string): string {
  const url = parseFalkorUrl(raw);
  const host = url.hostname;
  const port = url.port || String(DEFAULT_PORT);
  const scheme = url.protocol === "rediss:" ? "rediss" : "falkordb";
  return `${scheme}://${host}:${port}`;
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

export function parseFalkorSettings(
  settings: Record<string, string>,
  credentials: Record<string, string>,
): FalkorConnectionConfig {
  const url = normalizeFalkorUrl(requiredValue(settings, "url"));
  const username = credentials.username?.trim();
  const password = credentials.password ?? "";
  if (username && !password) throw new Error("password is required when username is set");
  return {
    url,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    namespace: settings.namespace?.trim() || DEFAULT_NAMESPACE,
    maxHops: parseIntegerSetting(settings.maxHops, 2, 1, 3, "maxHops"),
    allowWrites: parseBooleanSetting(settings.allowWrites, true),
    timeoutMs: parseIntegerSetting(
      settings.timeoutMs,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "timeoutMs",
    ),
    endpointTrust: settings.endpointTrust === "private" ? "private" : "public",
  };
}

function settingsForStorage(config: FalkorConnectionConfig): Record<string, string> {
  return {
    url: config.url,
    namespace: config.namespace,
    maxHops: String(config.maxHops),
    allowWrites: config.allowWrites ? "true" : "false",
    timeoutMs: String(config.timeoutMs),
    ...(config.endpointTrust === "private" ? { endpointTrust: "private" } : {}),
  };
}

function credentialsForStorage(credentials: Record<string, string>): Record<string, string> {
  const username = credentials.username?.trim();
  const password = credentials.password ?? "";
  return {
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
}

/** Loopback/LAN literals and blocked hostnames are deployment-owner territory. */
export function falkordbRequiresDeploymentOwner(settings: Record<string, string>): boolean {
  let url: URL;
  try {
    url = parseFalkorUrl(settings.url ?? "");
  } catch {
    return false;
  }
  const host = hostnameOf(url);
  if (isLocalMcpHost(host) || isBlockedHostname(host)) return true;
  if (isIP(host) !== 0) return isPrivateAddress(host);
  return false;
}

/**
 * DNS/trust classification without connecting. Callers enforce deployment-owner
 * authorization on the result before any credentialed probe.
 */
export async function classifyFalkorConnectionSettings(
  settings: Record<string, string>,
  resolveHostname?: ResolveHostname,
): Promise<Record<string, string>> {
  const url = parseFalkorUrl(requiredValue(settings, "url"));
  const host = hostnameOf(url);
  const classified: Record<string, string> = { ...settings, url: normalizeFalkorUrl(url.href) };
  const markPrivate = () => {
    classified.endpointTrust = "private";
    return classified;
  };
  if (isLocalMcpHost(host) || isBlockedHostname(host)) return markPrivate();
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) return markPrivate();
    delete classified.endpointTrust;
    return classified;
  }
  const resolve =
    resolveHostname ??
    (async (hostname: string) => {
      const { lookup } = await import("node:dns/promises");
      return lookup(hostname, { all: true, verbatim: true });
    });
  const addresses = await resolve(host);
  if (addresses.length === 0) {
    throw new Error("FalkorDB endpoint did not resolve to an address.");
  }
  if (addresses.some((entry) => isCloudMetadataAddress(entry.address))) {
    throw new Error("FalkorDB endpoint targets a blocked address.");
  }
  if (addresses.some((entry) => isPrivateAddress(entry.address))) return markPrivate();
  delete classified.endpointTrust;
  return classified;
}

/**
 * The falkordb client rewrites a `falkor` scheme prefix to `redis`, which turns
 * `falkordb://` into the invalid `redisdb://`. Hand it a plain redis URL instead;
 * `falkordb://` stays the user-facing scheme.
 */
export function falkorClientUrl(url: string): string {
  return url.startsWith("falkordb://") ? `redis://${url.slice("falkordb://".length)}` : url;
}

export const defaultFalkorConnect: FalkorConnect = async (config) => {
  // node-redis accepts reconnectStrategy even though falkordb's SocketOptions type omits it.
  const db = await FalkorDB.connect({
    url: falkorClientUrl(config.url),
    ...(config.username ? { username: config.username } : {}),
    ...(config.password ? { password: config.password } : {}),
    socket: { connectTimeout: config.timeoutMs, reconnectStrategy: false },
  } as Parameters<typeof FalkorDB.connect>[0]);
  return {
    selectGraph(name) {
      const graph = db.selectGraph(name);
      return {
        async query(cypher: string, params?: FalkorParams) {
          const reply = await graph.query<FalkorRow>(cypher, {
            params: params as never,
            TIMEOUT: config.timeoutMs,
          });
          return reply.data ?? [];
        },
        async roQuery(cypher: string, params?: FalkorParams) {
          const reply = await graph.roQuery<FalkorRow>(cypher, {
            params: params as never,
            TIMEOUT: config.timeoutMs,
          });
          return reply.data ?? [];
        },
      };
    },
    close: () => db.close(),
  };
};

interface PoolEntry {
  server: Promise<FalkorServer>;
  lastUsed: number;
}

function poolKey(config: FalkorConnectionConfig): string {
  const secret = config.password
    ? createHash("sha256").update(config.password).digest("hex").slice(0, 16)
    : "";
  return [config.url, config.username ?? "", secret].join("\n");
}

/** Reuses TCP connections across runs; providers are created per run. */
export class FalkorConnectionPool {
  private readonly entries = new Map<string, PoolEntry>();

  constructor(
    private readonly connect: FalkorConnect = defaultFalkorConnect,
    private readonly options: { idleMs?: number; maxConnections?: number } = {},
  ) {}

  async acquire(config: FalkorConnectionConfig): Promise<FalkorServer> {
    const now = Date.now();
    await this.sweep(now);
    const key = poolKey(config);
    let entry = this.entries.get(key);
    if (!entry) {
      const max = this.options.maxConnections ?? 8;
      if (this.entries.size >= max) this.evictOldest();
      const created: PoolEntry = { server: this.connect(config), lastUsed: now };
      created.server.catch(() => {
        if (this.entries.get(key) === created) this.entries.delete(key);
      });
      this.entries.set(key, created);
      entry = created;
    }
    entry.lastUsed = now;
    return entry.server;
  }

  /** Close entries unused for longer than idleMs. Called on acquire and by tests. */
  async sweep(now = Date.now()): Promise<void> {
    const idleMs = this.options.idleMs ?? 60_000;
    const closes: Promise<void>[] = [];
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsed <= idleMs) continue;
      this.entries.delete(key);
      closes.push(entry.server.then((server) => server.close()).catch(() => undefined));
    }
    await Promise.allSettled(closes);
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => entry.server.then((server) => server.close())));
  }

  get size(): number {
    return this.entries.size;
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.entries) {
      if (entry.lastUsed < oldest) {
        oldest = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (!oldestKey) return;
    const entry = this.entries.get(oldestKey);
    this.entries.delete(oldestKey);
    void entry?.server.then((server) => server.close()).catch(() => undefined);
  }
}

export const falkorConnections = new FalkorConnectionPool();

export async function probeFalkorConnection(
  config: FalkorConnectionConfig,
  connect: FalkorConnect = defaultFalkorConnect,
): Promise<void> {
  const server = await connect(config);
  try {
    await server.selectGraph(PROBE_GRAPH).roQuery("RETURN 1 AS ok");
  } finally {
    await server.close().catch(() => undefined);
  }
}

export async function prepareFalkorConnection(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  deps: FalkorPrepareDependencies = {},
  options?: { allowPrivateEndpoint?: boolean },
): Promise<{ settings: Record<string, string>; credentials: Record<string, string> }> {
  const classified = await classifyFalkorConnectionSettings(settings, deps.resolveHostname);
  // Reclassification can flip public→private between the API owner check and this probe.
  if (classified.endpointTrust === "private" && options?.allowPrivateEndpoint === false) {
    throw new MemoryProviderDeploymentOwnerRequiredError();
  }
  const config = parseFalkorSettings(classified, credentials);
  if (deps.probe !== false) {
    await probeFalkorConnection(config, deps.connect);
  }
  return {
    settings: settingsForStorage(config),
    credentials: credentialsForStorage(credentials),
  };
}

/** The graph verbs the provider uses. FalkorMemoryGraph satisfies this structurally. */
export interface MemoryGraphApi {
  readonly graphName: string;
  saveMemory(input: Parameters<FalkorMemoryGraph["saveMemory"]>[0]): Promise<{ id: string }>;
  recallMemories(
    input: Parameters<FalkorMemoryGraph["recallMemories"]>[0],
  ): Promise<GraphRecalledMemory[]>;
  forgetMemory(
    input: Parameters<FalkorMemoryGraph["forgetMemory"]>[0],
  ): Promise<{ expired: boolean }>;
  purgeHistory(input: Parameters<FalkorMemoryGraph["purgeHistory"]>[0]): Promise<void>;
  runReadOnlyQuery(cypher: string, limit?: number): Promise<ReadOnlyGraphQueryResult>;
}

export interface FalkorProviderDependencies {
  pool?: Pick<FalkorConnectionPool, "acquire">;
  /** Test seam: return a graph double without a server. */
  graphFor?: (spaceId: string) => Promise<MemoryGraphApi>;
}

function errorText(error: unknown, config: FalkorConnectionConfig): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|Socket closed|Connection is closed)/i.test(
      message,
    )
  ) {
    return `FalkorDB at ${config.url} is unreachable (${message}). Check the memory provider endpoint.`.slice(
      0,
      500,
    );
  }
  return `FalkorDB memory error: ${message}`.slice(0, 500);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export function createFalkorProvider(
  settings: Record<string, string>,
  credentials: Record<string, string>,
  deps?: FalkorProviderDependencies,
): SemanticMemoryProvider {
  return new FalkorMemoryProvider(parseFalkorSettings(settings, credentials), deps);
}

export class FalkorMemoryProvider implements SemanticMemoryProvider {
  private readonly graphs = new Map<string, Promise<MemoryGraphApi>>();

  constructor(
    private readonly config: FalkorConnectionConfig,
    private readonly deps: FalkorProviderDependencies = {},
  ) {}

  describe() {
    return {
      id: FALKORDB_PROVIDER_ID,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        recall: true,
        save: true,
        purgeHistory: true,
        sharedScope: true,
        graphQuery: true,
      } as const,
    };
  }

  private graphFor(spaceId: string, signal?: AbortSignal): Promise<MemoryGraphApi> {
    let graph = this.graphs.get(spaceId);
    if (!graph) {
      graph = (async () => {
        if (this.deps.graphFor) return this.deps.graphFor(spaceId);
        const server = await (this.deps.pool ?? falkorConnections).acquire(this.config);
        const graphName = spaceGraphName(this.config.namespace, spaceId);
        return new FalkorMemoryGraph(server.selectGraph(graphName), { graphName });
      })();
      this.graphs.set(spaceId, graph);
      graph.catch(() => this.graphs.delete(spaceId));
    }
    return raceAbort(graph, signal);
  }

  async recall(
    request: SemanticMemoryRecallRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<SemanticMemoryResult[]>> {
    const query = request.query.trim();
    if (!query) return { ok: true, value: [] };
    const limit = Math.max(1, Math.min(20, Math.trunc(request.limit) || 5));
    try {
      const graph = await this.graphFor(context.spaceId, context.signal);
      const recalled = await raceAbort(
        graph.recallMemories({
          spaceId: context.spaceId,
          botId: request.botId,
          userId: context.userId,
          scope: request.scope,
          query,
          limit,
          maxHops: this.config.maxHops,
          ...(request.historyGeneration === undefined
            ? {}
            : { historyGeneration: request.historyGeneration }),
        }),
        context.signal,
      );
      return {
        ok: true,
        value: recalled.map((memory) => ({
          memory: memory.text,
          score: memory.score,
          updatedAt: memory.updatedAt,
          id: memory.id,
          provenance: memory.provenance,
          entity: memory.entity,
        })),
      };
    } catch (error) {
      return { ok: false, error: errorText(error, this.config) };
    }
  }

  async save(
    request: SemanticMemorySaveRequest,
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    if (!this.config.allowWrites) {
      return {
        ok: false,
        error:
          "FalkorDB writes are disabled for this Space. Enable writing in Memory settings to save facts.",
      };
    }
    const content = request.content.trim();
    if (!content) return { ok: false, error: "Memory content is empty." };
    if (content.length > MAX_MEMORY_CHARS) {
      return {
        ok: false,
        error: `Memory content is too long (max ${MAX_MEMORY_CHARS} characters).`,
      };
    }
    const kind = request.source.kind === "history" ? "history" : "durable";
    const generation = request.source.kind === "history" ? request.source.generation : undefined;
    if (
      generation !== undefined &&
      (!Number.isInteger(generation) || generation < 0 || generation > 1_000_000)
    ) {
      return { ok: false, error: "History generation is invalid." };
    }
    try {
      const graph = await this.graphFor(context.spaceId, context.signal);
      await raceAbort(
        graph.saveMemory({
          id: memoryNodeId({
            spaceId: context.spaceId,
            scope: request.scope,
            botId: request.botId,
            kind,
            text: content,
            ...(generation === undefined ? {} : { generation }),
          }),
          text: content,
          kind,
          scope: request.scope,
          spaceId: context.spaceId,
          botId: request.botId,
          userId: context.userId,
          ...(generation === undefined ? {} : { generation }),
          sourceRunId: context.runId ?? context.operationId,
          ...(context.threadId ? { sourceThreadId: context.threadId } : {}),
          entities: extractMemoryEntities(content),
        }),
        context.signal,
      );
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: errorText(error, this.config) };
    }
  }

  async purgeHistory(
    request: { botId: string; generations: number[] },
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse> {
    if (!this.config.allowWrites) return { ok: true, value: undefined };
    if (request.generations.length === 0) return { ok: true, value: undefined };
    try {
      const graph = await this.graphFor(context.spaceId, context.signal);
      await raceAbort(graph.purgeHistory(request), context.signal);
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: errorText(error, this.config) };
    }
  }

  async forget(
    request: { id: string; reason?: string; entity?: string },
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<{ id: string; expired: boolean; reason: string | null }>> {
    if (!this.config.allowWrites) {
      return {
        ok: false,
        error:
          "FalkorDB writes are disabled for this Space. Enable writing in Memory settings to forget facts.",
      };
    }
    const id = request.id.trim();
    if (!id) return { ok: false, error: "Memory id is required." };
    try {
      const graph = await this.graphFor(context.spaceId, context.signal);
      const result = await raceAbort(
        graph.forgetMemory({
          memoryId: id,
          spaceId: context.spaceId,
          botId: context.botId ?? "",
          ...(request.reason ? { reason: request.reason } : {}),
        }),
        context.signal,
      );
      return {
        ok: true,
        value: { id, expired: result.expired, reason: request.reason ?? null },
      };
    } catch (error) {
      return { ok: false, error: errorText(error, this.config) };
    }
  }

  async queryGraph(
    request: { cypher: string; limit?: number },
    context: AdapterContext,
  ): Promise<SemanticMemoryResponse<ReadOnlyGraphQueryResult>> {
    try {
      const graph = await this.graphFor(context.spaceId, context.signal);
      const result = await raceAbort(
        graph.runReadOnlyQuery(request.cypher, request.limit),
        context.signal,
      );
      return { ok: true, value: result };
    } catch (error) {
      return { ok: false, error: errorText(error, this.config) };
    }
  }
}

export type { DurableMemoryScope };
