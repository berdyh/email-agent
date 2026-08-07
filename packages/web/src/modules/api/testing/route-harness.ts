/**
 * Drives real Next.js route handlers against a real temp-directory LanceDB.
 *
 * A route handler is a plain exported async function taking a `NextRequest` and
 * returning a `Response`. Nothing about testing one needs a server, a port or an
 * HTTP client — it needs the module to RESOLVE, which is what
 * `module-aliases.mjs` fixes, and it needs `$HOME` redirected before core is
 * loaded, which is what `packages/core/src/testing/lancedb-fixture.ts` already
 * does for core's own tests. This is those two, in the order that works:
 *
 *   1. redirect `$HOME` (so `LANCEDB_DIR` resolves into a temp directory),
 *   2. register the alias hook (so `@/…` and `@email-agent/core/…` resolve),
 *   3. `initDb()` on the temp database,
 *   4. only then import the route under test.
 *
 * Both the ordering guard and the seeding helpers are core's — importing them
 * through the alias rather than copying them is the point, since the whole
 * reason this file exists is that there were five hand-rolled fixtures.
 *
 * WHAT IT DOES NOT COVER, stated because the gap is easy to lose: this is the
 * handler, not the framework. Next's routing, middleware, response streaming
 * and React rendering are all outside it. There is no React testing library
 * here, so no component is ever rendered.
 */

import { register } from "node:module";

/** The default origin every fabricated request is same-origin with. */
export const TEST_ORIGIN = "http://localhost:3847";

let aliasesRegistered = false;

/**
 * Installs the tsconfig `paths` aliases for subsequent dynamic imports.
 * Idempotent — registering the same hook twice would run it twice per resolve.
 */
export function registerWebModuleAliases(): void {
  if (aliasesRegistered) return;
  register("./module-aliases.mjs", import.meta.url);
  aliasesRegistered = true;
}

export interface RouteHarness {
  /** The throwaway `$HOME`. */
  home: string;
  /** Imports a module by path relative to `packages/web/src`. */
  load: <T = Record<string, unknown>>(relativePath: string) => Promise<T>;
  /** Core's seeding/reading helpers, bound to the temp database. */
  db: typeof import("@email-agent/core/testing");
}

/**
 * Redirects `$HOME`, registers the aliases, initialises the database and hands
 * back a loader for route modules. Call at the TOP LEVEL of a test file, before
 * importing anything from `@/` or `@email-agent/core`.
 */
export async function startRouteHarness(label: string): Promise<RouteHarness> {
  registerWebModuleAliases();

  // Through the alias, so this is the SAME core module instance the routes get.
  // Two copies (one via the alias, one via node_modules -> dist) would give the
  // test one database and the route another. Importing the fixture is safe
  // before `$HOME` moves: it deliberately has no static core import, so nothing
  // has resolved `LANCEDB_DIR` yet.
  const db = (await import(
    "@email-agent/core/testing"
  )) as typeof import("@email-agent/core/testing");

  // Core's own guard: it redirects `$HOME`, re-reads `LANCEDB_DIR` and throws
  // if the result is not inside the temp directory, so a stray static import in
  // a test fails loudly here rather than writing to the developer's real
  // mailbox database. It also registers the teardown.
  const home = await db.useTempHome(`web-${label}`);
  await db.initTempDb();

  return {
    home: home.path,
    db,
    load: async <T,>(relativePath: string): Promise<T> => {
      const target = relativePath.startsWith("@/")
        ? relativePath
        : `@/${relativePath}`;
      return (await import(target)) as T;
    },
  };
}

// ---------------------------------------------------------------------------
// Request fabrication
// ---------------------------------------------------------------------------

export interface RequestOptions {
  method?: string;
  /** JSON body. Omit for a GET. */
  body?: unknown;
  /** Raw body text, for malformed-JSON cases. Wins over `body`. */
  rawBody?: string;
  /** Extra headers. `host` defaults to the test origin's authority. */
  headers?: Record<string, string>;
  /** Cookies, serialised into a single `cookie` header. */
  cookies?: Record<string, string>;
  /** Query string parameters. */
  query?: Record<string, string>;
  /**
   * Whether to attach the `Origin`/`Sec-Fetch-Site` pair a browser sends from
   * the app's own page. Default true — the guards refuse a bare POST, and a
   * test that means to exercise that refusal opts out explicitly.
   */
  sameOrigin?: boolean;
}

/**
 * A `NextRequest`-shaped request.
 *
 * Built as a real `Request` and then given the `nextUrl` and `cookies`
 * accessors the handlers use, rather than importing `NextRequest` — its
 * constructor pulls in Next's server runtime, and the handlers only touch those
 * two properties plus the standard `Request` surface.
 */
export function buildRequest(
  path: string,
  options: RequestOptions = {},
): import("next/server").NextRequest {
  const url = new URL(path, TEST_ORIGIN);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }

  const headers = new Headers(options.headers ?? {});
  if (!headers.has("host")) headers.set("host", url.host);
  if (options.sameOrigin !== false) {
    if (!headers.has("origin")) headers.set("origin", TEST_ORIGIN);
    if (!headers.has("sec-fetch-site")) headers.set("sec-fetch-site", "same-origin");
  }

  const cookies = Object.entries(options.cookies ?? {});
  if (cookies.length > 0) {
    headers.set(
      "cookie",
      cookies.map(([name, value]) => `${name}=${value}`).join("; "),
    );
  }

  const method = options.method ?? "GET";
  const hasBody = options.rawBody !== undefined || options.body !== undefined;
  if (hasBody && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const request = new Request(url, {
    method,
    headers,
    ...(hasBody && method !== "GET" && method !== "HEAD"
      ? { body: options.rawBody ?? JSON.stringify(options.body) }
      : {}),
  });

  const cookieMap = new Map(cookies);
  Object.defineProperties(request, {
    nextUrl: { value: url, configurable: true },
    cookies: {
      value: {
        get: (name: string) => {
          const value = cookieMap.get(name);
          return value === undefined ? undefined : { name, value };
        },
        getAll: () =>
          [...cookieMap].map(([name, value]) => ({ name, value })),
        has: (name: string) => cookieMap.has(name),
      },
      configurable: true,
    },
  });

  return request as unknown as import("next/server").NextRequest;
}

export interface HandlerResult<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
  /** `Set-Cookie` values, one per header line. */
  setCookies: string[];
  /** `Location`, for a redirect response. */
  location: string | null;
}

/** Runs a handler and decodes the response, JSON when it is JSON. */
export async function callHandler<T = unknown>(
  handler: (request: import("next/server").NextRequest) => Promise<Response>,
  request: import("next/server").NextRequest,
): Promise<HandlerResult<T>> {
  const response = await handler(request);
  const text = await response.text();
  let body: unknown = text;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      /* keep the raw text — an HTML or empty body is a real answer too */
    }
  }
  return {
    status: response.status,
    body: body as T,
    headers: response.headers,
    setCookies: response.headers.getSetCookie(),
    location: response.headers.get("location"),
  };
}

/** The value a `Set-Cookie` line assigns to `name`, or null. */
export function cookieValue(setCookies: string[], name: string): string | null {
  for (const line of setCookies) {
    const [pair] = line.split(";");
    const [cookieName, ...rest] = (pair ?? "").split("=");
    if (cookieName?.trim() === name) return rest.join("=");
  }
  return null;
}

/** The attributes on a `Set-Cookie` line for `name`, lowercased. */
export function cookieAttributes(
  setCookies: string[],
  name: string,
): string[] {
  for (const line of setCookies) {
    const parts = line.split(";").map((part) => part.trim());
    const [pair] = parts;
    if ((pair ?? "").split("=")[0]?.trim() === name) {
      return parts.slice(1).map((part) => part.toLowerCase());
    }
  }
  return [];
}
