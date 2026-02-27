import type { WebhookConfig } from "../config/types.js";

export interface WebhookPayload {
  title: string;
  message: string;
  priority?: string;
  emailId?: string;
}

function formatSlackPayload(payload: WebhookPayload): string {
  return JSON.stringify({
    text: `*${payload.title}*\n${payload.message}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${payload.title}*${payload.priority ? ` [${payload.priority}]` : ""}\n${payload.message}`,
        },
      },
    ],
  });
}

function formatDiscordPayload(payload: WebhookPayload): string {
  return JSON.stringify({
    embeds: [
      {
        title: payload.title,
        description: payload.message,
        color: payload.priority === "high" ? 0xff0000 : 0x0099ff,
      },
    ],
  });
}

function formatGenericPayload(payload: WebhookPayload): string {
  return JSON.stringify(payload);
}

export async function sendWebhookNotification(
  webhook: WebhookConfig,
  payload: WebhookPayload,
): Promise<void> {
  let body: string;

  switch (webhook.type) {
    case "slack":
      body = formatSlackPayload(payload);
      break;
    case "discord":
      body = formatDiscordPayload(payload);
      break;
    default:
      body = formatGenericPayload(payload);
  }

  const response = await fetch(webhook.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!response.ok) {
    throw new Error(
      `Webhook ${webhook.name} failed: ${response.status} ${response.statusText}`,
    );
  }
}
