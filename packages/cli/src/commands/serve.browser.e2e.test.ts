/**
 * The BROWSER leg of M2 (owner's decision D2) — a real Chromium, driven by
 * `puppeteer-core` against the SYSTEM install, exercising the actual flow a
 * person sees: `email-agent serve` prints a link, a browser with no cookie
 * meets a lock screen instead of a raw 403, opening the link unlocks it, and
 * the burned link no longer works.
 *
 * Everything up to "the exchange route returns a Set-Cookie with the right
 * attributes" is already covered without a browser at all (Tier 1:
 * `unlock.route.test.ts`, `session-guard.route.test.ts`, this file's sibling
 * `unlock.e2e.test.ts`). What ONLY a real browser proves, and what this file
 * is for: that the token the CLI parent prints is the same one the Next
 * CHILD process (a second process, spawned the way `serve` really spawns it)
 * accepts; that Chromium actually stores and returns the cookie under these
 * exact attributes over real `http://127.0.0.1`; that the exchange really
 * leaves the ORIGIN-SCOPED second factor in that browser's own
 * `localStorage`, and that the cookie WITHOUT it — the sibling-loopback-port
 * replay, since cookies are not scoped by port — is refused; and that a
 * locked page renders the unlock screen a person can act on rather than a
 * bare failure.
 *
 * `puppeteer-core`, NOT `puppeteer` — the latter downloads its own Chromium on
 * install, which is a devDependency none of this repo's other tests carry.
 * This drives the Chromium already on the machine
 * (`PUPPETEER_EXECUTABLE_PATH`, else `/usr/bin/chromium`, else a couple of
 * other common install paths). If none is found, the one test in this file
 * calls `t.skip(...)` with the paths it checked and returns — the suite still
 * exits 0, and the skip line names itself in the test-runner's own output, so
 * "did this run?" is never silently unanswerable.
 *
 * TIMING, measured on this machine (2026-08-22, cold — no other tests running
 * concurrently): building core + cli ~10s (already paid by `npm test` before
 * any test file runs), then this file alone: server up to first response
 * ~5s, three page navigations (each triggers a `next dev` on-demand route
 * compile) ~10-15s more. Call it 15-25s ADDED to the suite for this one file,
 * dominated by `next dev`'s dev-mode compilation, not by Chromium. A machine
 * under load, or CI with no Chromium installed, sees only the skip path,
 * which is near-instant.
 *
 * NOT exercised here, stated rather than left implicit: a second browser
 * engine (Tier 2 drives exactly one), the real 24-hour session TTL (an
 * injected clock proves that in `session.test.ts` instead), and
 * `/proc/<pid>/environ` visibility — none of those change by adding a
 * browser.
 */

import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Browser } from "puppeteer-core";

const execFileAsync = promisify(execFile);

// .../packages/cli/src/commands -> repo root
const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI_BIN = join(PACKAGES, "cli", "dist", "index.js");
const SEED_BIN = join(PACKAGES, "core", "dist", "testing", "seed-cli.js");

const LINK = /http:\/\/(\[[^\]]+\]|[^:\/\s]+):(\d+)\/unlock\?exchange=1#token=([A-Za-z0-9_-]+)/;

/**
 * Same discovery order documented in the module header. Checked in this
 * order so a developer or CI job can always override with the env var
 * without editing this file.
 */
const CHROMIUM_CANDIDATES = [
  process.env["PUPPETEER_EXECUTABLE_PATH"],
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
].filter((candidate): candidate is string => Boolean(candidate));

async function findChromiumExecutable(): Promise<string | undefined> {
  for (const candidate of CHROMIUM_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Not at this path — try the next candidate.
    }
  }
  return undefined;
}

/** An OS-assigned free loopback port, released immediately before use. */
async function getFreePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const probe = createServer();
    probe.on("error", rejectPromise);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address && typeof address === "object") {
        const port = address.port;
        probe.close(() => resolvePromise(port));
      } else {
        probe.close(() => rejectPromise(new Error("could not allocate a free port")));
      }
    });
  });
}

async function waitForHttp(url: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { redirect: "manual" });
      return;
    } catch (err) {
      lastError = err;
      await delay(300);
    }
  }
  throw new Error(`${url} never answered within ${deadlineMs}ms (last error: ${String(lastError)})`);
}

interface ServeHandle {
  origin: string;
  unlockUrl: string;
  /**
   * Everything the `serve` process tree has printed so far — the CLI parent AND
   * the `next dev` child, which is spawned with `stdio: "inherit"` and so
   * writes down these same pipes. That is precisely what makes the token-leak
   * assertion possible: the child's request logger prints the complete
   * `request.url` for every request it serves.
   */
  output: () => string;
  stop: () => Promise<void>;
}

/**
 * Spawns the REAL built `email-agent serve` — the same binary a user runs —
 * over a throwaway `$HOME`, on an OS-assigned free port, and scrapes the
 * printed unlock link from its stdout. That scrape is itself part of the
 * assertion: it is only possible because the parent really prints the link
 * before the Next child is ready, exactly as D4 specifies.
 *
 * `detached: true` puts the CLI process in its own process group; `serve`'s
 * own child (`npx next dev`, spawned with `stdio: "inherit"`, i.e. no
 * `detached` of its own) inherits that same group, so killing the NEGATIVE
 * pid at teardown reaches the whole tree in one signal — verified manually
 * against this exact spawn shape before relying on it here.
 */
async function startServe(): Promise<ServeHandle> {
  const home = await mkdtemp(join(tmpdir(), "email-agent-browser-e2e-"));
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  await execFileAsync(process.execPath, [SEED_BIN, "init"], { env, cwd: PACKAGES });

  const port = await getFreePort();
  const proc: ChildProcess = spawn(
    process.execPath,
    [CLI_BIN, "serve", "--port", String(port), "--host", "127.0.0.1"],
    { env, cwd: PACKAGES, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );

  // Accumulated for the whole lifetime of the process, not just until the link
  // appears: the request-log lines this test cares about are printed later,
  // once the browser starts navigating.
  let output = "";
  const unlockUrl = await new Promise<string>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`no unlock link printed within 15s. Output so far:\n${output}`));
    }, 15_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf-8");
      const match = output.match(LINK);
      if (match) {
        clearTimeout(timer);
        resolvePromise(match[0]);
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
  });

  const stop = async (): Promise<void> => {
    if (proc.pid) {
      try {
        process.kill(-proc.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
      await delay(500);
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        // Already reaped by SIGTERM.
      }
    }
    await rm(home, { recursive: true, force: true });
  };

  return { origin: `http://127.0.0.1:${port}`, unlockUrl, output: () => output, stop };
}

describe("email-agent serve — real browser (M2 Tier 2)", () => {
  it("locks an unauthenticated browser, unlocks the printed link, and burns it on replay", async (t) => {
    const chromiumPath = await findChromiumExecutable();
    if (!chromiumPath) {
      t.skip(
        "no Chromium executable found — checked PUPPETEER_EXECUTABLE_PATH and " +
          CHROMIUM_CANDIDATES.slice(1).join(", ") +
          ". The real-browser leg of M2 did not run; every other M2 assertion still did.",
      );
      return;
    }

    const puppeteer = (await import("puppeteer-core")).default;
    const handle = await startServe();
    let browser: Browser | undefined;
    try {
      await waitForHttp(handle.origin, 45_000);

      browser = await puppeteer.launch({
        executablePath: chromiumPath,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });

      // Leg 1 — no cookie at all. A guarded PAGE must render the unlock
      // screen, never a raw failure the user cannot act on.
      const lockedContext = await browser.createBrowserContext();
      try {
        const lockedPage = await lockedContext.newPage();
        await lockedPage.goto(`${handle.origin}/mail`, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await lockedPage.waitForFunction(() => (globalThis as any).location.pathname === "/unlock", {
          timeout: 20_000,
        });
        const lockedText = await lockedPage.evaluate(() => (globalThis as any).document.body.innerText);
        assert.match(lockedText, /locked/i);
        assert.match(lockedText, /email-agent unlock/);
      } finally {
        await lockedContext.close();
      }

      // Same claim from the API side, no browser needed: the guarded READ
      // route answers 401 with the stable code, not mail content.
      const unauthedRead = await fetch(`${handle.origin}/api/approvals`);
      assert.equal(unauthedRead.status, 401);
      const unauthedBody = (await unauthedRead.json()) as { code?: string };
      assert.equal(unauthedBody.code, "unlock-required");

      // Leg 2 — open the link the CLI parent actually printed. This is the
      // one assertion Tier 1 cannot make: that the digest the CHILD process
      // received really matches the token the PARENT printed.
      const unlockContext = await browser.createBrowserContext();
      let sessionCookieValue: string | undefined;
      let sessionBindingValue: string | undefined;
      try {
        const unlockPage = await unlockContext.newPage();
        await unlockPage.goto(handle.unlockUrl, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await unlockPage.waitForFunction(() => (globalThis as any).location.pathname === "/mail", {
          timeout: 20_000,
        });

        const cookies = await unlockContext.cookies();
        const sessionCookie = cookies.find((c) => c.name === "email_agent_session");
        assert.ok(sessionCookie, "no session cookie after redeeming the printed link");
        assert.equal(sessionCookie?.httpOnly, true);
        assert.equal(sessionCookie?.sameSite?.toLowerCase(), "lax");
        assert.equal(sessionCookie?.secure, false, "must be a plain-http cookie on loopback");
        assert.equal(sessionCookie?.path, "/");
        sessionCookieValue = sessionCookie?.value;

        // The ORIGIN-SCOPED second factor the exchange issued, read out of the
        // real browser's real localStorage — not a value this test minted.
        sessionBindingValue =
          (await unlockPage.evaluate(() =>
            (globalThis as any).localStorage.getItem("email-agent.session-binding"),
          )) ?? undefined;
        assert.ok(
          sessionBindingValue,
          "the unlock exchange did not leave a second factor in localStorage",
        );
        assert.notEqual(sessionBindingValue, sessionCookieValue);
      } finally {
        await unlockContext.close();
      }

      // THE SIBLING-LOOPBACK-PORT REPLAY, against a real browser's real
      // cookie. Cookies are not scoped by TCP port (RFC 6265 §8.5), so another
      // process binding 127.0.0.1:<anything> can be handed this exact value by
      // a cross-site top-level GET and replay it here — which is all this
      // request is. It must be refused, because the second factor lives in
      // localStorage, which IS scoped by origin, port included.
      //
      // This assertion used to expect 200. That was not a test bug at the
      // time — it was an accurate test of a contract that had this hole in it.
      assert.ok(sessionCookieValue, "cookie value missing — cannot check the API side");
      const replayedRead = await fetch(`${handle.origin}/api/approvals`, {
        headers: { cookie: `email_agent_session=${sessionCookieValue}` },
      });
      assert.equal(replayedRead.status, 401, "a bare cookie replay must not read mail");
      assert.equal(
        ((await replayedRead.json()) as { code?: string }).code,
        "binding-required",
        "and it must say WHY, so the browser can be sent somewhere recoverable",
      );

      // Both halves together — what the real UI sends — authorizes the read.
      const authedRead = await fetch(`${handle.origin}/api/approvals`, {
        headers: {
          cookie: `email_agent_session=${sessionCookieValue}`,
          "x-email-agent-session-binding": sessionBindingValue as string,
        },
      });
      assert.equal(authedRead.status, 200);

      // Leg 3 — a FRESH context (no cookie) replays the now-burned link. It
      // must not silently succeed a second time.
      const replayContext = await browser.createBrowserContext();
      try {
        const replayPage = await replayContext.newPage();
        await replayPage.goto(handle.unlockUrl, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        // `<UnlockExchange>` renders "Unlocking…" the instant it mounts, then
        // replaces that with the error state once the POST resolves — wait
        // for the actual outcome (the "Go to the unlock page" link only the
        // error branch renders), not just "some text exists".
        await replayPage.waitForSelector('a[href="/unlock"]', { timeout: 20_000 });
        assert.notEqual(
          replayPage.url(),
          `${handle.origin}/mail`,
          "a burned link must not unlock a second browser",
        );
        const replayText = await replayPage.evaluate(() => (globalThis as any).document.body.innerText);
        assert.match(replayText, /used|expired|did not work/i);
      } finally {
        await replayContext.close();
      }

      // Leg 4 — THE TOKEN NEVER REACHED THE SERVER'S LOG.
      //
      // This is the assertion for the fix that moved the token out of the query
      // string and into the URL fragment. `serve` runs `next dev`, whose
      // request logger prints the complete `request.url` for every request
      // (`next/dist/server/dev/log-requests.js`), and the child inherits these
      // pipes — so if the token were still a query parameter, it would be
      // sitting in `handle.output()` right now, printed by the server into the
      // same terminal a moment after the user clicked. A fragment is never
      // transmitted by any browser, so no request line can contain it.
      //
      // Both browsers above have now navigated the link, so the requests that
      // would carry it have certainly been served.
      const token = new URL(handle.unlockUrl).hash.replace(/^#token=/, "");
      assert.ok(token.length > 20, "could not recover the token from the printed link");
      const logged = handle
        .output()
        .split("\n")
        .filter((line) => line.includes(token) && /\b(GET|POST|HEAD)\s/.test(line));
      assert.deepEqual(
        logged,
        [],
        "the unlock token appeared in the server's request log — it must travel " +
          "in the URL fragment, which no browser sends",
      );
      // The link the CLI printed is of course still in the output; the point is
      // that it is there ONCE, from the parent, and not echoed back by the
      // child for every navigation.
      assert.ok(
        handle.output().includes(handle.unlockUrl),
        "sanity check: the printed link itself should be in the captured output",
      );
    } finally {
      await browser?.close();
      await handle.stop();
    }
  });
});
