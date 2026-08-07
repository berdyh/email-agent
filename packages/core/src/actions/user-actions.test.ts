import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { listUserActions, loadUserAction } from "./user-actions.js";

/**
 * These run against a real directory of real files, which only became possible
 * once the actions directory stopped being a homedir constant baked into the
 * module. That is the point: the bug below is not visible from either function
 * in isolation — it is a DISAGREEMENT between two of them.
 */
describe("user actions — one file, one identity", () => {
  let dir = "";
  let warnings: string[] = [];
  let restoreWarn: (() => void) | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "user-actions-"));
    warnings = [];
    const original = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map(String).join(" "));
    };
    restoreWarn = () => {
      console.warn = original;
    };
  });

  afterEach(async () => {
    restoreWarn?.();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const write = (filename: string, source: string): Promise<void> =>
    writeFile(join(dir, filename), source, "utf-8");

  it("loads a listed action by the id it was listed under", async () => {
    // The filename and the id deliberately disagree, because the id is the
    // file's, not the filename's.
    await write(
      "anything.action.ts",
      `export default { id: "triage", name: "Triage", description: "d", prompt: "p" };\n`,
    );

    const [listed, ...rest] = await listUserActions(dir);
    assert.equal(rest.length, 0);
    assert.equal(listed?.id, "triage");
    assert.equal(listed?.name, "Triage");
    assert.equal(listed?.description, "d");
    assert.equal(listed?.filename, "anything.action.ts");
    assert.equal(listed?.problem, undefined);

    const loaded = await loadUserAction(listed?.id ?? "", dir);
    assert.equal(loaded?.id, "triage");
    assert.equal(loaded?.prompt, "p");
    assert.equal(loaded?.builtIn, false);
    assert.deepEqual(warnings, [], "a healthy action must not warn");
  });

  it("says why a listed file will not run, instead of vanishing", async () => {
    // THE REGRESSION. `id: 1` is not a quoted string, so the regex the list
    // used found no id and fell back to the filename stem — while the loader
    // compared that same regex's `undefined` against the requested id, skipped
    // the file BEFORE extraction, and returned undefined. The caller reported
    // "Action not found" and the diagnostic that exists to explain exactly this
    // file never fired. Listing it under an id that cannot load it is the bug;
    // two readers of one file is the cause.
    await write("numeric.action.ts", `export default { id: 1, name: true, prompt: ["p"] };\n`);

    const [listed] = await listUserActions(dir);
    assert.equal(listed?.id, "numeric", "a file with no usable id still has to be listable");
    assert.match(
      listed?.problem ?? "",
      /`id` is a number/,
      "the list must carry the reason, not just an entry",
    );

    const loaded = await loadUserAction("numeric", dir);
    assert.equal(loaded, undefined);
    assert.equal(warnings.length, 1, `expected exactly one warning, got: ${warnings.join(" | ")}`);
    assert.match(warnings[0] ?? "", /numeric\.action\.ts exports no usable action/);
    assert.match(warnings[0] ?? "", /`id` is a number, `name` is a boolean, `prompt` is an array/);
    assert.match(warnings[0] ?? "", /non-empty strings/);
  });

  it("reports a refused file with its violations rather than a scraped name", async () => {
    await write(
      "hostile.action.ts",
      `const p = process.env.HOME;\nexport default { id: "hostile", name: "Hostile", prompt: p };\n`,
    );

    const [listed] = await listUserActions(dir);
    assert.equal(listed?.id, "hostile", "the filename stem, because nothing was safely parsed");
    assert.equal(listed?.name, "hostile", "NOT the `Hostile` a regex would have scraped out");
    assert.match(listed?.problem ?? "", /must be pure data/);
    assert.match(listed?.problem ?? "", /computed-value/);

    assert.equal(await loadUserAction("hostile", dir), undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /Refusing to load hostile\.action\.ts/);
    assert.match(warnings[0] ?? "", /NOT executed/);
  });

  it("stays quiet for an id nothing on disk answers to", async () => {
    await write(
      "ok.action.ts",
      `export default { id: "ok", name: "Ok", prompt: "p" };\n`,
    );

    assert.equal(await loadUserAction("no-such-action", dir), undefined);
    assert.deepEqual(warnings, [], "'no such action' is not a broken action");
  });

  it("prefers the file that really answers to an id over one that merely presents it", async () => {
    // `claimant.action.ts` presents the identity `claimant` only because its
    // stem says so; `real.action.ts` actually declares it. The declared one wins.
    await write("claimant.action.ts", `export default { id: 1, name: "x", prompt: "p" };\n`);
    await write(
      "real.action.ts",
      `export default { id: "claimant", name: "Real", prompt: "p" };\n`,
    );

    const loaded = await loadUserAction("claimant", dir);
    assert.equal(loaded?.name, "Real");
  });

  it("ignores files that are not user action files at all", async () => {
    await write("notes.txt", "hello");
    await write("ok.action.ts", `export default { id: "ok", name: "Ok", prompt: "p" };\n`);

    const listed = await listUserActions(dir);
    assert.deepEqual(
      listed.map((l) => l.filename),
      ["ok.action.ts"],
    );
  });

  it("returns nothing for a directory that does not exist", async () => {
    const missing = join(dir, "nope");
    assert.deepEqual(await listUserActions(missing), []);
    assert.equal(await loadUserAction("ok", missing), undefined);
  });
});
