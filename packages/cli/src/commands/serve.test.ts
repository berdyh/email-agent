import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { UNLOCK_GATE_DISABLED_LINES } from "@email-agent/core";
import {
  isLoopbackHost,
  resolveServeEnv,
  resolveServeHost,
  shouldPrintUnlockUrl,
} from "./serve.js";
import {
  buildUnlockUrl,
  describeUnlockDisabledLines,
  describeUnlockLines,
} from "../unlock-url.js";

describe("serve listener binding", () => {
  it("binds loopback by default", () => {
    // The API's local-origin checks read the Host header, which the caller
    // controls. Only the bind address is beyond a header's reach.
    assert.equal(resolveServeHost(undefined, {}), "127.0.0.1");
    assert.equal(
      resolveServeHost(undefined, { EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS: "0" }),
      "127.0.0.1",
    );
  });

  it("opens the bind under the documented remote escape hatch", () => {
    assert.equal(
      resolveServeHost(undefined, { EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS: "1" }),
      "0.0.0.0",
    );
  });

  it("lets an explicit --host win over both", () => {
    assert.equal(resolveServeHost("0.0.0.0", {}), "0.0.0.0");
    assert.equal(
      resolveServeHost("127.0.0.1", { EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS: "1" }),
      "127.0.0.1",
    );
  });

  it("knows which binds still deserve the exposure warning", () => {
    assert.equal(isLoopbackHost("127.0.0.1"), true);
    assert.equal(isLoopbackHost("::1"), true);
    assert.equal(isLoopbackHost("0.0.0.0"), false);
    assert.equal(isLoopbackHost("192.168.1.20"), false);
  });

  it("turns the header checks off whenever the bind is not loopback", () => {
    // `serve --host 0.0.0.0` opened the listener and left the API refusing
    // every LAN request with 403, because the guards still demanded a local
    // `Host`. The bind and the guards have to agree or `--host` does nothing
    // useful.
    const exposed = resolveServeEnv("0.0.0.0", {}, "3847");
    assert.equal(exposed["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"], "1");
    assert.equal(exposed["PORT"], "3847");

    assert.equal(
      resolveServeEnv("192.168.1.20", {}, "3847")["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"],
      "1",
    );
  });

  it("leaves the header checks on for a loopback bind", () => {
    // Including `--host 127.0.0.1` used to override the env flag's bind; it
    // must not now smuggle the relaxation in the other direction either.
    const local = resolveServeEnv("127.0.0.1", {}, "3847");
    assert.equal(local["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"], undefined);
    assert.equal(resolveServeEnv("::1", {}, "3847")["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"], undefined);
  });

  it("passes an explicitly set flag through even on a loopback bind", () => {
    // `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1 email-agent serve --host 127.0.0.1`
    // is a deliberate combination: bind loopback, accept a headless client.
    assert.equal(
      resolveServeEnv("127.0.0.1", { EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS: "1" }, "3847")[
        "EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"
      ],
      "1",
    );
  });
});

describe("the unlock link serve prints", () => {
  it("mints one exactly when the gate is actually running", () => {
    assert.equal(shouldPrintUnlockUrl("127.0.0.1", {}), true);
    assert.equal(shouldPrintUnlockUrl("localhost", {}), true);
    assert.equal(shouldPrintUnlockUrl("::1", {}), true);
  });

  it("prints nothing to unlock when the gate is off for this run", () => {
    // A non-loopback bind implies the remote flag, and the flag turns the gate
    // off. Printing a token there would claim a protection that is not running.
    assert.equal(shouldPrintUnlockUrl("0.0.0.0", {}), false);
    assert.equal(shouldPrintUnlockUrl("192.168.1.20", {}), false);
    assert.equal(
      shouldPrintUnlockUrl("127.0.0.1", { EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS: "1" }),
      false,
    );
  });

  it("prints the address the server actually bound, IPv6 bracketed", () => {
    // The session cookie has no Domain attribute, so it is host-only:
    // localhost:3847 and 127.0.0.1:3847 hold separate sessions. Printing the
    // wrong spelling costs the user a second token.
    assert.equal(
      buildUnlockUrl("127.0.0.1", "3847", "abc"),
      "http://127.0.0.1:3847/unlock?exchange=1#token=abc",
    );
    assert.equal(
      buildUnlockUrl("localhost", "9000", "abc"),
      "http://localhost:9000/unlock?exchange=1#token=abc",
    );
    assert.equal(
      buildUnlockUrl("::1", "3847", "abc"),
      "http://[::1]:3847/unlock?exchange=1#token=abc",
    );
  });

  it("keeps the token in the FRAGMENT, where no browser will send it to a server", () => {
    // The regression test for the shape itself, stated as the property rather
    // than as a string match: everything from `#` onwards is never transmitted,
    // so the token must be on that side of it and nothing else may be. It rode
    // in the query string until 2026-08-22, and `next dev`'s request logger
    // printed the complete `request.url` on every unlock.
    const url = buildUnlockUrl("127.0.0.1", "3847", "s3cr3t-token-value");
    const [sent, fragment] = url.split("#");

    assert.ok(fragment, "the link must carry a fragment");
    assert.match(fragment, /^token=s3cr3t-token-value$/);
    assert.doesNotMatch(
      sent as string,
      /s3cr3t-token-value/,
      "the part of the URL the browser SENDS must not contain the token",
    );
    // The marker that survives into the request log says only that somebody is
    // unlocking, which is what lets the page render the right thing first time.
    assert.equal(sent, "http://127.0.0.1:3847/unlock?exchange=1");
  });

  it("tells the reader the link is one-time, expiring, and how to get another", () => {
    const block = describeUnlockLines(buildUnlockUrl("127.0.0.1", "3847", "tok"), {
      pendingServerStart: true,
    }).join("\n");

    assert.match(block, /http:\/\/127\.0\.0\.1:3847\/unlock\?exchange=1#token=tok/);
    assert.match(block, /ONCE/);
    assert.match(block, /10 minutes/);
    assert.match(block, /email-agent unlock/);
    // serve spawns the child with inherited stdio and cannot see its readiness
    // line, so the block has to say the link may need a moment.
    assert.match(block, /reports it is ready/);
  });

  it("is actually wired into the command, not just exported", () => {
    // `serve` spawns a real Next server, so driving its startup output end to
    // end would mean booting one per assertion. The pure functions above carry
    // the behaviour; this pins that the action calls them, and calls them
    // BEFORE the spawn (D4) rather than after, where the link would never
    // appear until the child exited.
    const source = readFileSync(new URL("./serve.ts", import.meta.url), "utf-8");
    const printAt = source.indexOf("describeUnlockLines(");
    const spawnAt = source.indexOf("spawn(");

    assert.match(source, /shouldPrintUnlockUrl\(host, process\.env\)/);
    assert.match(source, /mintUnlockToken\(\)/);
    assert.match(source, /describeUnlockDisabledLines\(\)/);
    assert.ok(printAt > 0 && spawnAt > 0);
    assert.ok(printAt < spawnAt, "the unlock link must be printed before the child is spawned");
  });

  it("says plainly that nothing is gating the browser when the gate is off", () => {
    const block = describeUnlockDisabledLines().join("\n");

    assert.match(block, /OFF for this run/);
    assert.match(block, /EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1/);
  });

  it("uses core's wording, so the parent and the web child say the same thing", () => {
    // The web process now announces a disarmed gate itself (that is what makes
    // `npm run dev`/`npm run start` stop disarming it in silence), so under
    // `email-agent serve` the user sees this block twice — once from here,
    // once from the child. Two hand-written descriptions of one flag would
    // read as two problems, so the sentences must come from ONE place.
    const block = describeUnlockDisabledLines();

    for (const line of UNLOCK_GATE_DISABLED_LINES) {
      assert.ok(block.includes(line), `not core's wording: ${line}`);
    }
    assert.match(block.join("\n"), /same flag, not a second problem/);
  });
});
