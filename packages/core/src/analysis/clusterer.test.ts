import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeCluster } from "./cluster-summary.js";

describe("cluster summaries", () => {
  it("builds deterministic names and descriptions from subjects and senders", () => {
    const summary = summarizeCluster([
      {
        subject: "Invoice payment reminder",
        from: "billing@vendor.example",
        senderDomain: "vendor.example",
        snippet: "Payment due this week",
        bodyText: "The invoice payment is due this week.",
      },
      {
        subject: "Payment receipt",
        from: "billing@vendor.example",
        senderDomain: "vendor.example",
        snippet: "Invoice paid",
        bodyText: "Your payment receipt for the invoice.",
      },
    ]);

    assert.equal(summary.name, "Payment Invoice Receipt");
    assert.equal(
      summary.description,
      "2 emails about payment, invoice, receipt, due from vendor.example",
    );
  });
});
