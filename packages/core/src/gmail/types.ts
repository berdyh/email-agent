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
