import { loadSettings } from "../config/settings.js";
import { sendDesktopNotification } from "./desktop.js";
import { sendWebhookNotification, type WebhookPayload } from "./webhook.js";

export interface NotificationEvent {
  title: string;
  message: string;
  priority?: "high" | "medium" | "low";
  emailId?: string;
}

export class NotificationManager {
  async notify(event: NotificationEvent): Promise<void> {
    const settings = await loadSettings();
    const { desktop, webhooks } = settings.notifications;

    // Desktop notification
    if (desktop.enabled) {
      const shouldNotify =
        !desktop.priorityOnly || event.priority === "high";

      if (shouldNotify) {
        sendDesktopNotification({
          title: event.title,
          message: event.message,
          subtitle: event.priority ? `Priority: ${event.priority}` : undefined,
        });
      }
    }

    // Webhook notifications
    const payload: WebhookPayload = {
      title: event.title,
      message: event.message,
      priority: event.priority,
      emailId: event.emailId,
    };

    const enabledWebhooks = webhooks.filter((w) => w.enabled);
    const results = await Promise.allSettled(
      enabledWebhooks.map((w) => sendWebhookNotification(w, payload)),
    );

    // Log failures but don't throw
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === "rejected") {
        console.error(
          `Webhook "${enabledWebhooks[i]!.name}" failed:`,
          result.reason,
        );
      }
    }
  }
}
