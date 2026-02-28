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
    .description("Read a config value (e.g. gmail.syncActions)")
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
    .description("Set a config value (e.g. gmail.syncActions true)")
    .action(async (key: string, rawValue: string) => {
      const settings = await loadSettings();
      const obj = settings as unknown as Record<string, unknown>;
      setNestedValue(obj, key, parseValue(rawValue));
      await saveSettings(obj as unknown as AppConfig);
      console.log(chalk.green(`${key} = ${rawValue}`));
    });
}
