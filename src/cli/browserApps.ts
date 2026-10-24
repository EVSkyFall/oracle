import fs from "node:fs/promises";
import path from "node:path";
import type { BrowserAppMention } from "../browser/types.js";
import { normalizeBrowserApps } from "../browser/config.js";
import { parseAppMentionChipName } from "../browser/actions/appMentions.js";

/**
 * Builds the app mentions for a run from --browser-app names and --browser-app-chip files.
 * A chip's app name comes from its display-name attribute, so a chip and a plain name for the
 * same app merge into one mention that tries the chip first.
 */
export async function resolveBrowserAppMentions(
  names: readonly string[] | undefined,
  chipFiles: readonly string[] | undefined,
  cwd = process.cwd(),
): Promise<BrowserAppMention[] | undefined> {
  const chips: BrowserAppMention[] = [];
  for (const file of chipFiles ?? []) {
    if (!file.trim()) continue;
    let html: string;
    try {
      html = await fs.readFile(path.resolve(cwd, file), "utf8");
    } catch (error) {
      throw new Error(
        `--browser-app-chip ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const name = parseAppMentionChipName(html);
    if (!name) {
      throw new Error(
        `--browser-app-chip ${file}: no app-mention-display-name or plugin-mention-display-name attribute found; copy the mention chip from the ChatGPT composer.`,
      );
    }
    chips.push({ name, chipHtml: html });
  }
  const apps = normalizeBrowserApps([...(names ?? []), ...chips]);
  return apps.length > 0 ? apps : undefined;
}
