import { RequestValidationError } from "./validation.js";

export interface AccountScopedEmailRecord {
  accountId: string;
}

export function resolveActionRunAccountEmail(
  requestedAccountEmail: string | undefined,
  emailRecords: AccountScopedEmailRecord[],
): string | undefined {
  if (requestedAccountEmail !== undefined) return requestedAccountEmail;

  const accountIds = new Set(emailRecords.map((email) => email.accountId));
  if (accountIds.size > 1) {
    throw new RequestValidationError(
      "Select a single account before running actions that can apply Gmail operations",
    );
  }

  return [...accountIds][0];
}
