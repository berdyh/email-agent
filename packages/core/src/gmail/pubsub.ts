import { PubSub, type Subscription } from "@google-cloud/pubsub";
import { createGmailClient } from "./client.js";
import { loadSettings } from "../config/settings.js";
import type { WatchResponse } from "./types.js";

let pubsubClient: PubSub | null = null;

function getPubSub(): PubSub {
  if (!pubsubClient) {
    pubsubClient = new PubSub();
  }
  return pubsubClient;
}

export async function setupPubSub(): Promise<{
  topicName: string;
  subscriptionName: string;
}> {
  const settings = await loadSettings();
  const { projectId, pubsubTopic, pubsubSubscription } = settings.gcp;
  const pubsub = getPubSub();

  const topicName = `projects/${projectId}/topics/${pubsubTopic}`;
  const subscriptionName = `projects/${projectId}/subscriptions/${pubsubSubscription}`;

  // Create topic if it doesn't exist
  try {
    await pubsub.createTopic(topicName);
  } catch (err: any) {
    if (err.code !== 6) throw err; // 6 = ALREADY_EXISTS
  }

  // Grant Gmail permission to publish
  const topic = pubsub.topic(topicName);
  const [policy] = await topic.iam.getPolicy();
  const gmailServiceAccount = "serviceAccount:gmail-api-push@system.gserviceaccount.com";
  const publisherBinding = policy.bindings?.find(
    (b) => b.role === "roles/pubsub.publisher",
  );
  if (!publisherBinding) {
    policy.bindings = policy.bindings ?? [];
    policy.bindings.push({
      role: "roles/pubsub.publisher",
      members: [gmailServiceAccount],
    });
    await topic.iam.setPolicy(policy);
  } else if (!publisherBinding.members?.includes(gmailServiceAccount)) {
    publisherBinding.members = publisherBinding.members ?? [];
    publisherBinding.members.push(gmailServiceAccount);
    await topic.iam.setPolicy(policy);
  }

  // Create pull subscription if it doesn't exist
  try {
    await pubsub.createSubscription(topicName, subscriptionName);
  } catch (err: any) {
    if (err.code !== 6) throw err;
  }

  return { topicName, subscriptionName };
}

export async function startWatch(): Promise<WatchResponse> {
  const settings = await loadSettings();
  const { projectId, pubsubTopic } = settings.gcp;
  const gmail = await createGmailClient();

  const topicName = `projects/${projectId}/topics/${pubsubTopic}`;
  const response = await gmail.users.watch({
    userId: "me",
    requestBody: {
      topicName,
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    },
  });

  return {
    historyId: response.data.historyId!,
    expiration: response.data.expiration!,
  };
}

export function createPubSubListener(
  onMessage: (historyId: string) => void,
): Subscription {
  const pubsub = getPubSub();
  const settings = loadSettings(); // Will be awaited in the caller's context

  // Use sync path for subscription name based on defaults
  const subscription = pubsub.subscription("email-agent-sub");

  subscription.on("message", (message) => {
    const data = JSON.parse(message.data.toString());
    const historyId = data.historyId as string;
    message.ack();
    onMessage(historyId);
  });

  subscription.on("error", (error) => {
    console.error("PubSub listener error:", error);
  });

  return subscription;
}
