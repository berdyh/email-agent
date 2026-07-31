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
      const settings = await loadSettings();
      const obj = settings as unknown as Record<string, unknown>;
      setNestedValue(obj, key, parseValue(rawValue));
      await saveSettings(obj as unknown as AppConfig);

      // saveSettings normalizes, and auto-apply stays off until the risk
      // warnings are accepted in the web UI. Report what was actually stored
      // rather than echoing a value that silently did not take effect.
      const stored = await loadSettings();
      const effective = getNestedValue(
        stored as unknown as Record<string, unknown>,
        key,
      );
      console.log(chalk.green(`${key} = ${String(effective)}`));

      if (
        key === "gmail.autoApplyActions" &&
        parseValue(rawValue) === true &&
        effective !== true
      ) {
        console.log(
          chalk.yellow(
            "\nAuto-apply was NOT enabled: it lets actions trash, spam, or archive mail with no review.",
          ),
        );
        console.log(
          chalk.yellow(
            "Enable it in the web UI under Settings → Gmail, where the cautions must be read and accepted first.",
          ),
        );
      }
    });
}
