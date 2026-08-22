/**
 * The two things every component test in this package needs, in one place.
 *
 * TANSTACK QUERY CONTEXT. Nearly every component worth testing here reads data
 * through a hook in `src/hooks/`, and those are `useQuery`/`useMutation` — so
 * a bare `render()` throws "No QueryClient set". The client MUST be fresh per
 * test (a shared one carries the previous test's cache into the next one and
 * turns an empty-state assertion into a flake) and MUST have retries off: the
 * defaults retry a failed query three times with backoff, so the error branch
 * of a component would take ~30 seconds to appear and the test would time out
 * on a path that works.
 *
 * A RESPONSE BUILDER. `apiFetch` reads `res.ok`, `res.status` and `res.json()`,
 * and clones the response on a 401. jsdom provides a real `Response`, so a stub
 * should hand back a real one rather than a hand-rolled object literal that
 * happens to have the three fields today.
 *
 * WHAT IS DELIBERATELY NOT HERE: a fetch router. Tests stub `globalThis.fetch`
 * themselves with `vi.stubGlobal`, because what the server said is the premise
 * of the test and hiding it behind a table makes the interesting half of the
 * test invisible. `setup.ts` installs a fetch that throws, so forgetting is
 * loud.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      // See the header: retries turn a one-tick error assertion into a
      // multi-second one, and a cache that outlives the test is a flake.
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function renderWithQuery(
  ui: ReactElement,
  options: { queryClient?: QueryClient } = {},
): RenderResult & { queryClient: QueryClient } {
  const queryClient = options.queryClient ?? createTestQueryClient();
  const result = render(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  return { ...result, queryClient };
}

/** A real `Response`, so `res.ok`/`res.status`/`res.json()`/`res.clone()` all behave. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
