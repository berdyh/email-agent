import type { Command } from "commander";
import chalk from "chalk";
import {
  getNestedConfigValue,
  loadSettings,
  saveSettings,
  setNestedConfigValue,
  UnsafeConfigPathError,
} from "@email-agent/core";
import type { AppConfig } from "@email-agent/core";

/**
 * The dotted-path helpers are CORE's (`config/dotted-path.ts`), not local
 * copies. The copies that used to sit here refused nothing, so
 * `config set __proto__.x true` wrote to `Object.prototype` in this process —
 * not currently exploitable (see the guard's own header for why that depends on
 * a property of `normalizeSettings`, not of this command), but the guard had no
 * caller at all until now. The local `setNestedValue` also had a latent bug the
 * shared one does not: `typeof null === "object"`, so a null intermediate was
 * walked into rather than replaced.
 */

/** Turns a refused path into one line, rather than a stack trace. */
function reportUnsafePath(err: UnsafeConfigPathError): void {
  console.error(chalk.red(err.message));
  console.error(
    chalk.yellow(
      `The offending segment is "${err.segment}". Config keys address settings, ` +
        `not the JavaScript prototype chain.`,
    ),
  );
}

/**
 * Keys that arm unattended Gmail mutations. They are deliberately NOT settable
 * from this dotted-path writer: the acknowledgement is only meaningful if the
 * user actually saw the warnings, and this command cannot show them. Without
 * this guard, `config set gmail.autoApplyAcknowledged true` would record
 * informed consent that was never given, and the normalizeSettings invariant
 * (which only checks that the flag is set, not where it came from) would honor it.
 */
const CONSENT_GATED_KEYS = new Set([
  "gmail.autoApplyActions",
  "gmail.autoApplyAcknowledged",
]);

/**
 * Keys this writer used to accept and no longer does, with where the setting
 * actually lives now. `oauth` was a settings block that `normalizeSettings`
 * persisted and NO code path ever read for authentication — a plaintext Google
 * client secret at rest behind a field that read as the configuration step.
 * `PUT /api/settings` refuses it loudly (`Unknown setting: oauth`, 400); this
 * refusal is the CLI saying the same thing rather than the two surfaces
 * disagreeing about the same removed key.
 *
 * Matched on the first segment, so `oauth` and `oauth.clientSecret` are both
 * refused. A refusal here happens BEFORE `saveSettings`, so nothing is written.
 */
const REMOVED_KEYS = new Map([
  [
    "oauth",
    "Google OAuth client credentials are not settings. They live in\n" +
      "~/.email-agent/oauth.json as {clientId, clientSecret}, which `setup.sh`\n" +
      "writes, and `gmail/account-manager.ts` reads from nowhere else.",
  ],
]);

function parseValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  const num = Number(raw);
  if (!isNaN(num) && raw.trim() !== "") return num;
  return raw;
}

export function registerConfig(program: Command) {
  const config = program
    .command("config")
    .description("Get or set configuration values");

  config
    .command("get <key>")
    .description("Read a config value (e.g. ui.fetchScope)")
    .action(async (key: string) => {
      const settings = await loadSettings();
      let value: unknown;
      try {
        value = getNestedConfigValue(settings as unknown as Record<string, unknown>, key);
      } catch (err) {
        if (!(err instanceof UnsafeConfigPathError)) throw err;
        reportUnsafePath(err);
        process.exit(1);
      }
      if (value === undefined) {
        console.error(chalk.red(`Key "${key}" not found`));
        process.exit(1);
      }
      console.log(typeof value === "object" ? JSON.stringify(value, null, 2) : String(value));
    });

  config
    .command("set <key> <value>")
    .description("Set a config value (e.g. ui.fetchScope all)")
    .action(async (key: string, rawValue: string) => {
      if (CONSENT_GATED_KEYS.has(key)) {
        console.error(
          chalk.red(`"${key}" cannot be set from the CLI.`),
        );
        console.error(
          chalk.yellow(
            "\nAuto-apply lets actions trash, spam, or archive mail with no review,\n" +
              "so it may only be armed where its warnings can be shown and accepted:\n" +
              "the web UI under Settings → Gmail.",
          ),
        );
        process.exit(1);
      }

      const removed = REMOVED_KEYS.get(key.split(".")[0] ?? "");
      if (removed !== undefined) {
        console.error(chalk.red(`"${key}" is no longer a setting.`));
        console.error(chalk.yellow(`\n${removed}`));
        process.exit(1);
      }

      const settings = await loadSettings();
      const obj = settings as unknown as Record<string, unknown>;
      try {
        // Throws BEFORE touching `obj`, so a refused write changes nothing.
        setNestedConfigValue(obj, key, parseValue(rawValue));
      } catch (err) {
        if (!(err instanceof UnsafeConfigPathError)) throw err;
        reportUnsafePath(err);
        process.exit(1);
      }
      await saveSettings(obj as unknown as AppConfig);

      // saveSettings normalizes, so report what was actually stored rather
      // than echoing a value that silently did not take effect.
      const stored = await loadSettings();
      const effective = getNestedConfigValue(
        stored as unknown as Record<string, unknown>,
        key,
      );

      // A key that is absent after the save is a key normalization dropped —
      // an unknown section, or one removed from `AppConfig`. Printing
      // `key = undefined` in GREEN with exit 0 reports a write that did not
      // happen, which is the one thing this read-back exists to prevent.
      if (effective === undefined) {
        console.error(chalk.red(`"${key}" was not stored.`));
        console.error(
          chalk.yellow(
            "The value did not survive normalization, so this is not a setting\n" +
              "this build recognises. Nothing was changed.",
          ),
        );
        process.exit(1);
      }

      console.log(chalk.green(`${key} = ${String(effective)}`));
    });
}
