import type { Command } from "commander";
import chalk from "chalk";
import { loadSettings, saveSettings } from "@email-agent/core";
import type { AppConfig } from "@email-agent/core";

/**
 * Get a nested value from an object using a dotted key path.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * Set a nested value on an object using a dotted key path.
 */
function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const keys = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (current[key] === undefined || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
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
      const value = getNestedValue(settings as unknown as Record<string, unknown>, key);
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

      const settings = await loadSettings();
      const obj = settings as unknown as Record<string, unknown>;
      setNestedValue(obj, key, parseValue(rawValue));
      await saveSettings(obj as unknown as AppConfig);

      // saveSettings normalizes, so report what was actually stored rather
      // than echoing a value that silently did not take effect.
      const stored = await loadSettings();
      const effective = getNestedValue(
        stored as unknown as Record<string, unknown>,
        key,
      );
      console.log(chalk.green(`${key} = ${String(effective)}`));
    });
}
