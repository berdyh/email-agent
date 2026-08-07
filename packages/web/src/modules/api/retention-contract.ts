/**
 * The approval-queue retention field on the Settings page, as a value rather
 * than as whatever `Number()` makes of the input's string.
 *
 * Deliberately free of any `@email-agent/core` import, like the other contract
 * modules here: the Settings page is client code and may not pull core runtime
 * into the browser bundle. The DEFAULT window is therefore not restated here
 * either — `sanitizeSettingsForResponse` already fills `retention` from
 * `defaultConfig` on every response, so the page seeds this field from the
 * settings it fetched and no second copy of the number exists to drift.
 */

/**
 * What the field currently holds. `null` is the CLEARED state and it is not a
 * number.
 *
 * AN EMPTY FIELD IS NOT ZERO. `Number("")` is 0, and 0 is a real, meaningful
 * value here — "never delete anything" — so reading a cleared input as a number
 * flipped the helper text to "0 disables deletion, every record is kept
 * forever" while the user was mid-keystroke, and saving at that moment wrote 0.
 * The direction was non-destructive, but an empty field silently meant
 * something specific, which is the part that had to go.
 */
export type RetentionDraft = number | null;

/**
 * Reads the input's raw string. Anything that is not a usable number — empty,
 * whitespace, or text a browser let through on a `type="number"` field — is
 * `null`, because all of them mean the same thing: there is no value to save.
 */
export function parseRetentionDraft(raw: string): RetentionDraft {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const days = Number(trimmed);
  if (!Number.isFinite(days)) return null;
  return days;
}

/** True while the field holds nothing a save could use. */
export function retentionDraftIsEmpty(raw: string): boolean {
  return parseRetentionDraft(raw) === null;
}

/**
 * The helper line under the field. Three states, never two: an empty field says
 * that it is empty and that saving will not change the window, rather than
 * borrowing the sentence that belongs to 0.
 */
export function describeRetentionWindow(days: RetentionDraft): string {
  if (days === null) {
    return (
      "The field is empty, so the retention window is not being changed — saving now keeps " +
      "whatever is already set. Type 0 if you want every record kept forever."
    );
  }
  if (days > 0) {
    return `Records older than ${days} days are deleted the next time you apply or reject something.`;
  }
  return "0 disables deletion — every record is kept forever.";
}
