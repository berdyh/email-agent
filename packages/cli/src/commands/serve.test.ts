import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isLoopbackHost, resolveServeHost } from "./serve.js";

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
});
