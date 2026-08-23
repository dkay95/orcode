#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  COMMAND_CATALOG,
  type CommandCatalogDefinition,
} from "../src/command-catalog.js";

export const COMMAND_DOCS_START = "<!-- orcode:command-docs:start -->";
export const COMMAND_DOCS_END = "<!-- orcode:command-docs:end -->";

const README_URL = new URL("../README.md", import.meta.url);

export function renderCommandDocs(
  catalog: readonly CommandCatalogDefinition[] = COMMAND_CATALOG,
): string {
  const rows = catalog.map((command) => {
    const aliases = (command.aliases ?? [])
      .map((alias) => inlineCode(`/${alias}`))
      .join(", ");
    return [
      inlineCode(`/${command.name}`),
      aliases,
      inlineCode(command.usage),
      escapeMarkdownCell(command.description),
    ].join(" | ");
  });
  return [
    "| Command | Aliases | Usage | Description |",
    "| --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
}

export function commandDocsBlock(table = renderCommandDocs()): string {
  return `${COMMAND_DOCS_START}\n${table}\n${COMMAND_DOCS_END}`;
}

export function replaceCommandDocs(readme: string, table = renderCommandDocs()): string {
  const start = readme.indexOf(COMMAND_DOCS_START);
  const end = readme.indexOf(COMMAND_DOCS_END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(
      `README command markers fehlen oder sind vertauscht: ${COMMAND_DOCS_START} … ${COMMAND_DOCS_END}`,
    );
  }
  const afterEnd = end + COMMAND_DOCS_END.length;
  return `${readme.slice(0, start)}${commandDocsBlock(table)}${readme.slice(afterEnd)}`;
}

function inlineCode(value: string): string {
  return `\`${escapeMarkdownCell(value).replace(/`/g, "\\`")}\``;
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const unknown = [...args].filter((argument) => argument !== "--check");
  if (unknown.length > 0) {
    throw new Error(`Unbekannte Option: ${unknown.join(", ")}`);
  }

  const current = await readFile(README_URL, "utf8");
  const expected = replaceCommandDocs(current);
  if (expected === current) {
    console.log("README command docs are current.");
    return;
  }
  if (args.has("--check")) {
    console.error(
      "README command docs are stale. Run: node --import tsx scripts/render-command-docs.ts",
    );
    process.exitCode = 1;
    return;
  }
  await writeFile(README_URL, expected, "utf8");
  console.log(`Updated ${fileURLToPath(README_URL)}.`);
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entrypoint === import.meta.url) {
  await main();
}
