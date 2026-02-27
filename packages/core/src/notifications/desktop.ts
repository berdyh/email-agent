import notifier from "node-notifier";

export interface DesktopNotificationOptions {
  title: string;
  message: string;
  subtitle?: string;
}

export function sendDesktopNotification(
  options: DesktopNotificationOptions,
): void {
  const message = options.subtitle
    ? `${options.subtitle}\n${options.message}`
    : options.message;

  notifier.notify({
    title: options.title,
    message,
    wait: false,
  });
}
