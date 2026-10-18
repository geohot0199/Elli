/** Example for the empty endpoint field. Not a connection default. */
export const FALKORDB_URL_PLACEHOLDER = "falkordb://localhost:6379";

export type FalkorDBFieldError = "url-required" | "password-required";

/**
 * The endpoint must be configured. A blank value is not filled with a local default,
 * so a hosted deployment cannot silently connect to localhost. URL validity stays on
 * the backend (`parseFalkorUrl`); the overlay shows that error after connect.
 */
export function falkordbUrlError(url: string): FalkorDBFieldError | null {
  if (!url.trim()) return "url-required";
  return null;
}

export function falkordbConnectionDraft(input: {
  url: string;
  username: string;
  password: string;
  namespace: string;
  maxHops: number;
  allowWrites: boolean;
}):
  | {
      ok: true;
      draft: { settings: Record<string, string>; credentials: Record<string, string> };
    }
  | { ok: false; error: FalkorDBFieldError } {
  const error = falkordbUrlError(input.url);
  if (error) return { ok: false, error };
  const username = input.username.trim();
  const password = input.password;
  if (username && !password) return { ok: false, error: "password-required" };
  const namespace = input.namespace.trim();
  return {
    ok: true,
    draft: {
      settings: {
        url: input.url.trim(),
        maxHops: String(input.maxHops),
        allowWrites: input.allowWrites ? "true" : "false",
        ...(namespace ? { namespace } : {}),
      },
      credentials: {
        ...(username ? { username } : {}),
        ...(password ? { password } : {}),
      },
    },
  };
}

/** Show a compact host label without leaking credentials or paths. */
export function falkordbConnectedLabel(settings: Record<string, string>): string {
  const raw = settings.url?.trim();
  if (!raw) return "FalkorDB";
  try {
    const url = new URL(raw);
    return url.host || raw;
  } catch {
    return raw;
  }
}
