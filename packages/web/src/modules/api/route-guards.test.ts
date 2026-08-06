import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import { describe, it } from "node:test";

const API_DIR = fileURLToPath(new URL("../../app/api", import.meta.url));

const HANDLER = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g;
const GUARD_CALL = /\b(mutationGuardResponse|readGuardResponse)\s*\(/;

/**
 * Routes that deliberately run without a guard, and why. Adding a route here is
 * a decision someone has to write down; forgetting to guard one is not.
 */
const EXEMPT = new Map<string, string>([
  [
    "auth/callback/route.ts GET",
    "Google redirects the browser here as a top-level cross-site navigation, " +
      "which the shared guard refuses by design. Its CSRF protection is the " +
      "one-time OAuth state cookie, and it returns no mail or settings.",
  ],
]);

async function routeFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await routeFiles(full)));
    else if (entry.name === "route.ts") files.push(full);
  }
  return files.sort();
}

/** Body of one handler: from its declaration to the next one, or end of file. */
function handlerBodies(source: string): Array<{ method: string; body: string }> {
  const starts: Array<{ method: string; index: number }> = [];
  for (const match of source.matchAll(HANDLER)) {
    starts.push({ method: match[1] as string, index: match.index });
  }
  return starts.map((start, i) => ({
    method: start.method,
    body: source.slice(start.index, starts[i + 1]?.index ?? source.length),
  }));
}

describe("API route guards", () => {
  it("guards every handler in every route, or names it as an exemption", async () => {
    const files = await routeFiles(API_DIR);
    // A sanity floor: if the walk silently found nothing, the assertions below
    // would all pass vacuously.
    assert.ok(files.length >= 15, `expected to find the API routes, saw ${files.length}`);

    const unguarded: string[] = [];
    const seenExemptions = new Set<string>();

    for (const file of files) {
      const source = await readFile(file, "utf8");
      const id = relative(API_DIR, file).split(sep).join("/");
      const handlers = handlerBodies(source);
      assert.ok(handlers.length > 0, `${id} exports no HTTP handler`);

      for (const handler of handlers) {
        const key = `${id} ${handler.method}`;
        if (EXEMPT.has(key)) {
          seenExemptions.add(key);
          continue;
        }
        if (!GUARD_CALL.test(handler.body)) unguarded.push(key);
      }
    }

    // `GET /api/actions/[id]/results` returned the model's raw text, the email
    // ids it acted on and its reasons, with no guard at all — found only after
    // the branch claimed every mail-returning read was covered. This sweeps the
    // whole surface so the next one is a test failure, not a review finding.
    assert.deepEqual(unguarded, []);

    // A stale exemption is its own kind of lie about the surface.
    for (const key of EXEMPT.keys()) {
      assert.ok(seenExemptions.has(key), `exemption "${key}" no longer matches a handler`);
    }
  });
});
