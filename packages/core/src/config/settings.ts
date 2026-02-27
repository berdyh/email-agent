import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { SETTINGS_PATH, defaultConfig } from "./defaults.js";
import type { AppConfig } from "./types.js";

let cachedSettings: AppConfig | null = null;

export async function loadSettings(): Promise<AppConfig> {
  if (cachedSettings) return cachedSettings;

  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    cachedSettings = { ...defaultConfig, ...parsed };
  } catch {
    cachedSettings = { ...defaultConfig };
  }
  return cachedSettings;
}

export async function saveSettings(config: AppConfig): Promise<void> {
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(config, null, 2));
  cachedSettings = config;
}

export async function getSetting<K extends keyof AppConfig>(
  key: K,
): Promise<AppConfig[K]> {
  const settings = await loadSettings();
  return settings[key];
}

export async function setSetting<K extends keyof AppConfig>(
  key: K,
  value: AppConfig[K],
): Promise<void> {
  const settings = await loadSettings();
  settings[key] = value;
  await saveSettings(settings);
}

export function clearSettingsCache(): void {
  cachedSettings = null;
}
