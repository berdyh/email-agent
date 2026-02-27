export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  bodyText: string;
  bodyHtml: string;
  labels: string[];
  isUnread: boolean;
  senderDomain: string;
  snippet: string;
}

export interface GmailThread {
  id: string;
  messages: GmailMessage[];
  subject: string;
  snippet: string;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
}

export interface WatchResponse {
  historyId: string;
  expiration: string;
}
