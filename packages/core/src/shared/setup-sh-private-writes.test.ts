/**
 * `setup.sh`'s private-write helpers, RUN rather than grepped for.
 *
 * WHY THIS FILE EXISTS AT ALL. `setup.sh` writes two things into
 * `~/.email-agent` from bash, before any of this package is necessarily
 * involved: `settings.json`, and `oauth.json` — which holds the Google OAuth
 * client id AND client secret. Both used a plain `mkdir -p` + `cat >`, so under
 * the common `umask 022` the directory landed at 0755 and the files at 0644.
 * `settings.json` is rewritten through `shared/private-files.ts` the first time
 * the app saves settings, which repaired it by accident; NOTHING in the app ever
 * rewrites `oauth.json`, so a credential stayed world-readable for the life of
 * the install. That is the same hole the mail database had, reached through a
 * path no amount of hardening inside `packages/core` can cover.
 *
 * WHY IT LIVES UNDER `packages/core/src/shared/`. The test runner's glob is
 * `packages/ ** /*.test.ts`, so a repo-root script has nowhere else to be
 * tested from — and this is the right neighbour anyway: it is the bash twin of
 * `private-files.ts`, sitting beside it so the two policies are read together.
 *
 * WHY EXTRACT-AND-RUN RATHER THAN A TEXT SCAN. `setup.sh` is a top-level
 * interactive script with no `main`, so sourcing it would run the whole wizard.
 * Asserting that the file merely CONTAINS `chmod 600` would pass against a
 * `chmod` on the wrong path, in the wrong order, or after the bytes were already
 * on disk loose. So the marked block is cut out of the real file and executed by
 * a real bash, and the modes it produces are measured. The only coupling is the
 * pair of marker lines.
 *
 * The umask is pinned to 022 for the reason given in
 * `shared/private-dir-tree.test.ts`: under `umask 077` every assertion here
 * would pass against the defect itself.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const SETUP_SH = new URL("../../../../setup.sh", import.meta.url).pathname;

const START = "# --- private writes ---";
const END = "# --- end private writes ---";

function extractHelpers(): string {
  const source = readFileSync(SETUP_SH, "utf-8");
  const start = source.indexOf(START);
  const end = source.indexOf(END);
  assert.ok(
    start >= 0 && end > start,
    `setup.sh no longer carries the "${START}" / "${END}" markers this test ` +
      `extracts its helpers from. If the helpers moved, move the markers with ` +
      `them — do not delete this test.`,
  );
  return source.slice(start, end);
}

const workdir = mkdtempSync(join(tmpdir(), "email-agent-setup-sh-"));
after(() => rmSync(workdir, { recursive: true, force: true }));

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Runs `script` with setup.sh's own helpers in scope, at umask 022. */
function runWithHelpers(script: string): void {
  execFileSync("bash", ["-euo", "pipefail", "-c", `umask 022\n${extractHelpers()}\n${script}`], {
    cwd: workdir,
    encoding: "utf-8",
  });
}

test("write_private_file lands 0600 inside 0700, on a fresh tree", () => {
  const home = join(workdir, "fresh");
  runWithHelpers(
    `write_private_file "${home}/.email-agent/oauth.json" <<'EOF'\n` +
      `{"clientId":"x","clientSecret":"y"}\nEOF`,
  );

  assert.equal(modeOf(join(home, ".email-agent")), 0o700);
  assert.equal(modeOf(join(home, ".email-agent", "oauth.json")), 0o600);
  assert.equal(
    readFileSync(join(home, ".email-agent", "oauth.json"), "utf-8"),
    '{"clientId":"x","clientSecret":"y"}\n',
    "the heredoc body must survive the temp-file-and-rename intact",
  );
});

test("write_private_file tightens a directory and a file that already exist loose", () => {
  // The upgrade case, in bash: `mkdir -p` leaves an existing 0755 directory
  // alone, and a `cat >` over an existing 0644 file keeps 0644 forever. Both are
  // why the helper chmods unconditionally and renames a fresh temp file over the
  // target rather than writing in place.
  const home = join(workdir, "loose");
  runWithHelpers(
    `mkdir -p "${home}/.email-agent"\n` +
      `chmod 755 "${home}/.email-agent"\n` +
      `printf 'old\\n' > "${home}/.email-agent/oauth.json"\n` +
      `chmod 644 "${home}/.email-agent/oauth.json"\n` +
      `write_private_file "${home}/.email-agent/oauth.json" <<'EOF'\nnew\nEOF`,
  );

  assert.equal(modeOf(join(home, ".email-agent")), 0o700);
  assert.equal(modeOf(join(home, ".email-agent", "oauth.json")), 0o600);
  assert.equal(readFileSync(join(home, ".email-agent", "oauth.json"), "utf-8"), "new\n");
});

test("setup.sh routes BOTH of its writes through the helper", () => {
  // Not a proxy for the modes — the two tests above measure those. This is the
  // wiring: a helper nothing calls hardens nothing, and these are the only two
  // files setup.sh creates under ~/.email-agent.
  const source = readFileSync(SETUP_SH, "utf-8");
  const body = source.slice(source.indexOf(END));
  assert.match(body, /write_private_file "\$SETTINGS_FILE" <<SETTINGS_EOF/);
  assert.match(body, /write_private_file "\$OAUTH_FILE" <<OAUTH_EOF/);
  assert.doesNotMatch(
    body,
    /mkdir -p "\$HOME\/\.email-agent"|mkdir -p "\$SETTINGS_DIR"/,
    "a bare mkdir here creates ~/.email-agent at the umask, i.e. 0755",
  );
});
