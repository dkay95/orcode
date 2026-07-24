export interface SlashCommandDefinition {
  name: string;
  usage: string;
  description: string;
  aliases?: readonly string[];
  acceptsArguments?: boolean;
}

export const SLASH_COMMANDS: readonly SlashCommandDefinition[] = [
  {
    name: "model",
    usage: "/model [anbieter/modell|current]",
    description: "Main-Modell suchen, auswählen oder anzeigen",
    acceptsArguments: true,
  },
  {
    name: "think",
    usage: "/think [auto|off|Stufe|budget Tokens]",
    description: "Reasoning-Stufe oder Thinking-Budget steuern",
    aliases: ["reasoning"],
    acceptsArguments: true,
  },
  {
    name: "allow",
    usage: "/allow [Modus]",
    description: "Freigaben interaktiv von read-only bis allow-all wählen",
    aliases: ["approval", "approvals", "permissions"],
    acceptsArguments: true,
  },
  {
    name: "chat",
    usage: "/chat [new|list|open|search|rename|fork]",
    description: "Chats durchsuchen, auswählen, anlegen, umbenennen oder verzweigen",
    aliases: ["chats", "switch"],
    acceptsArguments: true,
  },
  {
    name: "new",
    usage: "/new [Titel]",
    description: "Einen neuen, getrennten Chat im Workspace beginnen",
    acceptsArguments: true,
  },
  {
    name: "fork",
    usage: "/fork [Titel]",
    description: "Aktuellen Chat samt Kontext als neuen Chat verzweigen",
    acceptsArguments: true,
  },
  {
    name: "compress",
    usage: "/compress [Modus|model]",
    description: "Kompressor-Modell interaktiv wählen oder Modus konfigurieren",
    aliases: ["compressor"],
    acceptsArguments: true,
  },
  {
    name: "status",
    usage: "/status",
    description: "Modelle, Modi, Limits und Workspace anzeigen",
  },
  {
    name: "key",
    usage: "/key [set|status|forget|management]",
    description: "OpenRouter-Schlüssel sicher verwalten",
    acceptsArguments: true,
  },
  {
    name: "balance",
    usage: "/balance",
    description: "Guthaben und Key-Limit erneut prüfen",
    aliases: ["credits"],
  },
  {
    name: "reconnect",
    usage: "/reconnect",
    description: "OpenRouter-Verbindung neu aufbauen und prüfen",
  },
  {
    name: "models",
    usage: "/models [Suche]",
    description: "Tool-fähige OpenRouter-Modelle auflisten",
    acceptsArguments: true,
  },
  {
    name: "cost",
    usage: "/cost",
    description: "Kosten dieser Workspace-Sitzung anzeigen",
    aliases: ["costs"],
  },
  {
    name: "max-cost",
    usage: "/max-cost [USD]",
    description: "Kostenlimit pro Main-Agent-Lauf setzen",
    acceptsArguments: true,
  },
  {
    name: "steps",
    usage: "/steps [Anzahl]",
    description: "Maximale Tool-Schritte pro Lauf setzen",
    acceptsArguments: true,
  },
  {
    name: "history",
    usage: "/history [Anzahl]",
    description: "Letzte Gesprächsrunden anzeigen",
    acceptsArguments: true,
  },
  {
    name: "diff",
    usage: "/diff",
    description: "Aktuellen Git-Diff anzeigen",
  },
  {
    name: "undo",
    usage: "/undo",
    description: "Letzte RouterCode-Dateiänderung zurücknehmen",
  },
  {
    name: "clear",
    usage: "/clear",
    description: "Gesprächskontext und Sitzungskosten zurücksetzen",
  },
  {
    name: "init",
    usage: "/init",
    description: "ROUTERCODE.md im Workspace anlegen",
  },
  {
    name: "config",
    usage: "/config",
    description: "Gespeicherte, nicht geheime Konfiguration anzeigen",
  },
  {
    name: "help",
    usage: "/help",
    description: "Alle Befehle und ihre Verwendung anzeigen",
    aliases: ["?"],
  },
  {
    name: "quit",
    usage: "/quit",
    description: "RouterCode beenden",
    aliases: ["exit", "q"],
  },
] as const;

const COMPRESSOR_SUBCOMMANDS: readonly SlashCommandDefinition[] = [
  {
    name: "compress model",
    usage: "/compress model",
    description: "Kompressor-Modell interaktiv suchen und auswählen",
  },
  {
    name: "compress auto",
    usage: "/compress auto",
    description: "Kontext nur bei Bedarf automatisch komprimieren",
  },
  {
    name: "compress always",
    usage: "/compress always",
    description: "Kontext vor jedem Main-Modell-Lauf komprimieren",
  },
  {
    name: "compress off",
    usage: "/compress off",
    description: "Kontext-Kompressor vollständig deaktivieren",
  },
  {
    name: "compress threshold",
    usage: "/compress threshold <Zeichen>",
    description: "Zeichenschwelle für automatische Kompression setzen",
    acceptsArguments: true,
  },
  {
    name: "compress max-cost",
    usage: "/compress max-cost <USD>",
    description: "Eigenes Kostenlimit für einen Kompressor-Lauf setzen",
    acceptsArguments: true,
  },
] as const;

export function rankSlashCommands(
  input: string,
  commands: readonly SlashCommandDefinition[] = SLASH_COMMANDS,
): SlashCommandDefinition[] {
  if (!input.startsWith("/")) {
    return [];
  }
  const raw = input.slice(1).trimStart();
  const token = raw.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  const compressor = commands.find(
    (command) =>
      command.name === "compress" &&
      (command.name === token || command.aliases?.includes(token)),
  );
  if (compressor) {
    const remainder = raw.slice(raw.split(/\s+/, 1)[0]?.length ?? 0).trimStart();
    if (!remainder) {
      return input.endsWith(" ")
        ? [...COMPRESSOR_SUBCOMMANDS]
        : [compressor, ...COMPRESSOR_SUBCOMMANDS];
    }
    const subcommandToken = remainder.split(/\s+/, 1)[0]?.toLowerCase() ?? "";
    return rankCommandDefinitions(
      COMPRESSOR_SUBCOMMANDS,
      subcommandToken,
      (command) => command.name.split(/\s+/).at(-1) ?? command.name,
    );
  }
  return rankCommandDefinitions(commands, token);
}

function rankCommandDefinitions(
  commands: readonly SlashCommandDefinition[],
  token: string,
  nameOf: (command: SlashCommandDefinition) => string = (command) =>
    command.name,
): SlashCommandDefinition[] {
  return commands
    .map((command, index) => ({
      command,
      index,
      score: commandScore(command, token, nameOf(command)),
    }))
    .filter(({ score }) => score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ command }) => command);
}

export function commandTokenIsExact(
  input: string,
  command: SlashCommandDefinition,
): boolean {
  const inputTokens = input
    .slice(1)
    .trimStart()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const commandTokens = command.name.toLowerCase().split(/\s+/);
  if (commandTokens.length > 1) {
    return commandTokens.every(
      (token, index) => inputTokens[index] === token,
    );
  }
  const token = inputTokens[0] ?? "";
  return command.name === token || Boolean(command.aliases?.includes(token));
}

function commandScore(
  command: SlashCommandDefinition,
  token: string,
  primaryName = command.name,
): number {
  if (!token) {
    return 0;
  }
  const names = [primaryName, ...(command.aliases ?? [])];
  if (names.includes(token)) {
    return 10_000;
  }
  if (names.some((name) => name.startsWith(token))) {
    return 5_000 - command.name.length;
  }
  return names.some((name) => name.includes(token))
    ? 1_000 - command.name.length
    : -1;
}
