import { createGmailClient } from "./client.js";

export async function markAsRead(messageId: string): Promise<void> {
  const gmail = await createGmailClient();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { removeLabelIds: ["UNREAD"] },
  });
}

export async function markAsUnread(messageId: string): Promise<void> {
  const gmail = await createGmailClient();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds: ["UNREAD"] },
  });
}

export async function trashMessage(messageId: string): Promise<void> {
  const gmail = await createGmailClient();
  await gmail.users.messages.trash({
    userId: "me",
    id: messageId,
  });
}

export async function markAsSpam(messageId: string): Promise<void> {
  const gmail = await createGmailClient();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      addLabelIds: ["SPAM"],
      removeLabelIds: ["INBOX"],
    },
  });
}

export async function addLabels(
  messageId: string,
  labelIds: string[],
): Promise<void> {
  const gmail = await createGmailClient();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { addLabelIds: labelIds },
  });
}

export async function removeLabels(
  messageId: string,
  labelIds: string[],
): Promise<void> {
  const gmail = await createGmailClient();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { removeLabelIds: labelIds },
  });
}

export async function batchModify(params: {
  messageIds: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
}): Promise<void> {
  const gmail = await createGmailClient();
  await gmail.users.messages.batchModify({
    userId: "me",
    requestBody: {
      ids: params.messageIds,
      addLabelIds: params.addLabelIds,
      removeLabelIds: params.removeLabelIds,
    },
  });
}
