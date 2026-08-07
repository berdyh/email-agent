import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { ActionRegistry } from "./registry.js";
import { listUserActions, loadUserAction } from "./user-actions.js";

const run = promisify(execFile);

/**
 * The denied case, proven BEHAVIOURALLY.
 *
 * Every previous version of this proof was syntactic: scan the loaders for
 * `await import(`, then for any call whose callee is an identifier named
 * `Function`/`eval`/`require`. Each version was defeated by re-spelling —
 * `new Function(...)` moved to another module, then `globalThis.Function(...)`
 * bound to a local name, which is a property-access call the scan never looked
 * at. That is the denylist trap the guard itself exists to avoid, played three
 * times on the guard's own test.
 *
 * No syntactic scan can honestly claim "however it is spelled", because the
 * language has unbounded ways to name a value. So this test does not look at
 * the loaders at all. It puts genuinely malicious `.action.ts` files on disk —
 * files whose top level writes a marker — loads them through the REAL
 * `loadUserAction()` and `ActionRegistry.loadAll()`, and asserts the marker is
 * not there. Re-spelling the hatch cannot defeat that, because the assertion is
 * about what happened, not about how the code reads.
 *
 * Each payload is first proven hostile by importing it natively: if the marker
 * does not appear THAT way, the payload is inert and the test proves nothing.
 * That check is what makes this evidence rather than decoration.
 *
 * (Closes the P3 backlog entry "No end-to-end denied-case test with an
 * injectable `ACTIONS_DIR`", which was previously verified only by hand with an
 * overridden `HOME`.)
 */

/** Env var each payload reads to find the marker it should write. */
const MARKER_ENV = "EMAIL_AGENT_TEST_MARKER";

interface Payload {
  /** How the payload reaches the filesystem — the "spelling" being tested. */
  spelling: string;
  filename: string;
  source: string;
}

/**
 * Every payload writes `process.env[MARKER_ENV]` at MODULE EVALUATION time, and
 * every one of them also exports a perfectly well-formed action, so a loader
 * that ran the file would both leave a marker and hand back a usable action.
 */
const PAYLOADS: Payload[] = [
  {
    spelling: "a plain value import of node:fs",
    filename: "value-import.action.ts",
    source: `import { writeFileSync } from "node:fs";
writeFileSync(process.env.${MARKER_ENV}, "executed");
export default { id: "value-import", name: "Value import", prompt: "p" };
`,
  },
  {
    spelling: "a bare member-access side effect on a global",
    filename: "member-access.action.ts",
    source: `globalThis.process.getBuiltinModule("node:fs").writeFileSync(globalThis.process.env.${MARKER_ENV}, "executed");
export default { id: "member-access", name: "Member access", prompt: "p" };
`,
  },
  {
    spelling: "the Function constructor reached without naming it",
    filename: "fn-ctor.action.ts",
    source: `const g = ({}).constructor.constructor("return globalThis")();
const fs = await ({}).constructor.constructor("return import('node:fs')")();
fs.writeFileSync(g.process.env.${MARKER_ENV}, "executed");
export default { id: "fn-ctor", name: "Function constructor", prompt: "p" };
`,
  },
  {
    spelling: "a live data: URL hidden behind an `as type` re-export",
    filename: "data-url.action.ts",
    source: `export { default as type } from "data:text/javascript,${encodeURIComponent(
      `globalThis.process.getBuiltinModule("node:fs").writeFileSync(globalThis.process.env.${MARKER_ENV}, "executed"); export default 1;`,
    )}";
export default { id: "data-url", name: "Data URL", prompt: "p" };
`,
  },
  {
    spelling: "a `using` disposal hook, which runs after the last statement",
    filename: "using-dispose.action.ts",
    source: `using handle = {
  [Symbol.dispose]() {
    globalThis.process.getBuiltinModule("node:fs").writeFileSync(globalThis.process.env.${MARKER_ENV}, "executed");
  },
};
export default { id: "using-dispose", name: "Using dispose", prompt: "p" };
`,
  },
  {
    spelling: "the same payload as .action.js, not .action.ts",
    filename: "javascript.action.js",
    source: `globalThis.process.getBuiltinModule("node:fs").writeFileSync(globalThis.process.env.${MARKER_ENV}, "executed");
export default { id: "javascript", name: "JavaScript", prompt: "p" };
`,
  },
];

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

describe("user action load path — a hostile file never executes, end to end", () => {
  let dir = "";
  const markerFor = (payload: Payload): string => join(dir, `${payload.filename}.marker`);

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "denied-load-path-"));
    // `type: module` so a native import of these files is an ESM evaluation,
    // exactly as it would be under `ACTIONS_DIR`.
    await writeFile(join(dir, "package.json"), '{"type":"module"}', "utf8");
    for (const payload of PAYLOADS) {
      await writeFile(join(dir, payload.filename), payload.source, "utf8");
    }
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("proves each payload really does execute when imported", async () => {
    // Without this, "the marker was not written" is equally consistent with the
    // payloads being harmless. Each is imported in a clean subprocess so the
    // test process never has the hostile code in its module graph.
    const notHostile: string[] = [];
    for (const payload of PAYLOADS) {
      const marker = markerFor(payload);
      await rm(marker, { force: true });
      try {
        await run(
          process.execPath,
          [
            "--disable-warning=ExperimentalWarning",
            "-e",
            `await import(process.argv[1]);`,
            join(dir, payload.filename),
          ],
          { cwd: dir, env: { ...process.env, [MARKER_ENV]: marker } },
        );
      } catch {
        // Some payloads may throw AFTER writing; only the marker matters.
      }
      if (!(await exists(marker))) notHostile.push(`${payload.filename} — ${payload.spelling}`);
    }
    assert.deepEqual(
      notHostile,
      [],
      `these payloads did not execute even when natively imported, so they prove nothing:\n  ${notHostile.join("\n  ")}`,
    );
  });

  it("does not execute any of them through loadUserAction() or ActionRegistry", async () => {
    // Fresh markers, and the env var set in THIS process — so if any loader ran
    // a payload, it would find the path it needs and the file would appear.
    const previousMarkerEnv = process.env[MARKER_ENV];
    const executed: string[] = [];
    const loadedAnyway: string[] = [];
    const silent: string[] = [];
    const warnings: string[] = [];
    let registryContents: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      for (const payload of PAYLOADS) {
        await rm(markerFor(payload), { force: true });
      }

      for (const payload of PAYLOADS) {
        process.env[MARKER_ENV] = markerFor(payload);

        const before = warnings.length;
        const action = await loadUserAction(payload.filename.replace(/\.action\.[tj]s$/, ""), dir);
        if (action !== undefined) loadedAnyway.push(`loadUserAction: ${payload.filename}`);
        // A refused file must be diagnosable — silently skipping one is how
        // "my action disappeared" becomes unanswerable.
        if (warnings.length === before) silent.push(payload.filename);
      }

      const registry = new ActionRegistry({ userActionsDir: dir });
      await registry.loadAll();
      for (const payload of PAYLOADS) {
        const id = payload.filename.replace(/\.action\.[tj]s$/, "");
        if (registry.get(id) !== undefined) loadedAnyway.push(`ActionRegistry: ${payload.filename}`);
      }
      registryContents = registry.getAll().map((a) => `${a.id}:${a.builtIn === true}`);
      // ...and listing them must not execute them either.
      await listUserActions(dir);

      for (const payload of PAYLOADS) {
        if (await exists(markerFor(payload))) {
          executed.push(`${payload.filename} — ${payload.spelling}`);
        }
      }
    } finally {
      console.warn = originalWarn;
      if (previousMarkerEnv === undefined) delete process.env[MARKER_ENV];
      else process.env[MARKER_ENV] = previousMarkerEnv;
    }

    assert.deepEqual(
      executed,
      [],
      `THE LOAD PATH EXECUTED AN ACTION FILE. Markers written by:\n  ${executed.join("\n  ")}`,
    );
    assert.deepEqual(
      loadedAnyway,
      [],
      `a refused file must not yield an action either:\n  ${loadedAnyway.join("\n  ")}`,
    );
    assert.deepEqual(silent, [], `refused without saying why: ${silent.join(", ")}`);
    for (const payload of PAYLOADS) {
      assert.ok(
        warnings.some((w) => w.includes(payload.filename)),
        `no warning named ${payload.filename}; got:\n${warnings.join("\n")}`,
      );
    }
    // The built-ins must still be there, or "nothing executed" is trivially
    // true because nothing loaded at all.
    assert.ok(registryContents.length > 0, "the registry loaded no actions whatsoever");
    assert.deepEqual(
      registryContents.filter((entry) => !entry.endsWith(":true")),
      [],
      "only reviewed in-repo built-ins may end up in the registry here",
    );
  });

  it("leaves the hostile files on disk, refused rather than removed", async () => {
    // The loaders read; they must not delete, quarantine, or rewrite. A file the
    // user can no longer see is a file they cannot fix.
    const onDisk = new Set(await readdir(dir));
    for (const payload of PAYLOADS) {
      assert.ok(onDisk.has(payload.filename), `${payload.filename} must still be on disk`);
    }
  });
});
