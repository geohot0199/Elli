import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FALKORDB_URL_PLACEHOLDER,
  falkordbConnectedLabel,
  falkordbConnectionDraft,
  falkordbUrlError,
} from "./falkordb-settings";

describe("FalkorDB memory provider settings", () => {
  it("does not register a default endpoint", () => {
    const registry = readFileSync(fileURLToPath(new URL("./registry.ts", import.meta.url)), "utf8");
    expect(registry).toContain(
      "Graph-native durable memory: multi-hop recall, shared Space facts, and read-only graph queries.",
    );
    expect(registry).not.toContain("DEFAULT_FALKORDB");
    expect(FALKORDB_URL_PLACEHOLDER).toBe("falkordb://localhost:6379");

    const form = readFileSync(
      fileURLToPath(new URL("./FalkorDBSettingsForm.tsx", import.meta.url)),
      "utf8",
    );
    expect(form).toContain('const [url, setUrl] = useState("");');
    expect(form).toContain("placeholder={FALKORDB_URL_PLACEHOLDER}");
  });

  it("requires an explicit endpoint and leaves URL validity to the backend", () => {
    expect(falkordbUrlError("")).toBe("url-required");
    expect(falkordbUrlError("   ")).toBe("url-required");
    expect(falkordbUrlError("not a url")).toBeNull();
    expect(falkordbUrlError("http://localhost:6379")).toBeNull();
    expect(falkordbUrlError(FALKORDB_URL_PLACEHOLDER)).toBeNull();

    expect(
      falkordbConnectionDraft({
        url: "",
        username: "",
        password: "",
        namespace: "rakazo",
        maxHops: 2,
        allowWrites: true,
      }),
    ).toEqual({ ok: false, error: "url-required" });
  });

  it("builds a settings and credentials draft", () => {
    expect(
      falkordbConnectionDraft({
        url: " falkordb://graph.internal:6379 ",
        username: " rakazo ",
        password: "secret",
        namespace: " team ",
        maxHops: 3,
        allowWrites: false,
      }),
    ).toEqual({
      ok: true,
      draft: {
        settings: {
          url: "falkordb://graph.internal:6379",
          maxHops: "3",
          allowWrites: "false",
          namespace: "team",
        },
        credentials: { username: "rakazo", password: "secret" },
      },
    });

    expect(
      falkordbConnectionDraft({
        url: FALKORDB_URL_PLACEHOLDER,
        username: "",
        password: "",
        namespace: "",
        maxHops: 2,
        allowWrites: true,
      }),
    ).toEqual({
      ok: true,
      draft: {
        settings: {
          url: "falkordb://localhost:6379",
          maxHops: "2",
          allowWrites: "true",
        },
        credentials: {},
      },
    });
  });

  it("requires a password when a username is set", () => {
    expect(
      falkordbConnectionDraft({
        url: FALKORDB_URL_PLACEHOLDER,
        username: "rakazo",
        password: "",
        namespace: "",
        maxHops: 2,
        allowWrites: true,
      }),
    ).toEqual({ ok: false, error: "password-required" });
  });

  it("shows a host label without credentials or paths", () => {
    expect(falkordbConnectedLabel({})).toBe("FalkorDB");
    expect(falkordbConnectedLabel({ url: "falkordb://graph.internal:6379" })).toBe(
      "graph.internal:6379",
    );
    expect(falkordbConnectedLabel({ url: "not a url" })).toBe("not a url");
  });
});
