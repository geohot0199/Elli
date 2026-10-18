import type { ConnectorTool } from "@rakazo/adapter-kit";

const SEMANTIC_MEMORY_TOOL_NAMES = new Set([
  "recall_memory",
  "save_memory",
  "forget_memory",
  "query_memory_graph",
]);
const GRAPH_MEMORY_TOOL_NAMES = new Set(["query_memory_graph"]);

/**
 * Native `remember` and provider-backed semantic memory are alternatives, so only one
 * family is exposed. Graph query tools additionally need a provider that implements them.
 */
export function selectMemoryTools(
  tools: ConnectorTool[],
  semanticMemoryConfigured: boolean,
  graphMemoryEnabled = false,
): ConnectorTool[] {
  return tools.filter((tool) => {
    if (GRAPH_MEMORY_TOOL_NAMES.has(tool.name)) {
      return semanticMemoryConfigured && graphMemoryEnabled;
    }
    if (!semanticMemoryConfigured) return !SEMANTIC_MEMORY_TOOL_NAMES.has(tool.name);
    return tool.name !== "remember";
  });
}
