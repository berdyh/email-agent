import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLoopbackHost, resolveServeEnv, resolveServeHost } from "./serve.js";

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
