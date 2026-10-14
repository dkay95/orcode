//! Owner-confirmed terminal handoffs. No command, URL, path or credential is
//! accepted from the WebView/record; only these closed vendor/action enums.
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::process::Command;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="lowercase")]
pub enum Provider { Codex, Claude, Kimi }

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="kebab-case")]
pub enum Action { Install, Login, OpenExternal }

fn vendor(provider: Provider) -> (&'static str, &'static str, &'static str, &'static str) {
    match provider {
        Provider::Codex => ("Codex", "codex", "npm install -g @openai/codex", "codex login"),
        Provider::Claude => ("Claude Code", "claude", "curl -fsSL https://claude.ai/install.sh | bash", "claude --safe-mode --setting-sources '' auth login"),
        Provider::Kimi => ("Kimi Code", "kimi", "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash", "kimi login"),
    }
}

pub fn instructions(provider: Provider, action: Action) -> String {
    let (name, _, install, login) = vendor(provider);
    match action {
        Action::Install => format!("{name} über die offizielle Herstellerquelle installieren. Eine vorhandene CLI wird nicht überschrieben.\n\n{install}\n\nDanach in orcode erneut prüfen. Das geöffnete Fenster bestätigt noch keine Installation."),
        Action::Login => format!("Die Anmeldung läuft im Hersteller-Terminal. orcode erhält keine Login-Tokens.\n\n{login}\n\nEine bestehende Anmeldung wird nicht automatisch abgemeldet. Danach in orcode erneut prüfen."),
        Action::OpenExternal => format!("Ein separates {name}-Terminal öffnen. Dort gelten die eigenen Freigaben der Hersteller-CLI, nicht die orcode-Schalter.\n\nWähle im Terminal dein Projekt und Modell. Eine externe Sitzung wird nicht als integrierter GUI-Agent angezeigt."),
    }
}

fn script(provider: Provider, action: Action) -> String {
    let (name, binary, install, login) = vendor(provider);
    // Non-interactive -f avoids shell-profile hooks and API-key shadowing.
    // All inserted values above are fixed source literals, never user input.
    let operation = match action {
        Action::Install => format!("if command -v {binary} >/dev/null 2>&1; then\n  print 'CLI bereits vorhanden. Nichts wird ersetzt oder heruntergestuft.'\nelse\n  {install}\nfi\n"),
        Action::Login => format!("if ! command -v {binary} >/dev/null 2>&1; then\n  print 'CLI nicht gefunden. Bitte zuerst die offizielle Installation ausführen.'\n  exit 1\nfi\n{login}\n"),
        Action::OpenExternal => format!("print '{name} · separates Hersteller-Terminal'\nprint 'Öffne zuerst dein Projekt mit cd und wähle dein Modell in der Hersteller-CLI.'\nprint 'orcode hat hier keinen Agenten gestartet und überwacht diese Sitzung nicht.'\nexec /bin/zsh -f\n"),
    };
    format!("#!/bin/zsh -f\nset -eu\nexport PATH=\"/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/.kimi-code/bin:$PATH\"\nunset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY OPENAI_API_KEY CODEX_API_KEY\n{operation}\nprint 'Kehre zu orcode zurück und prüfe den Status erneut.'\nread -r '?Enter zum Schließen'\n")
}

#[cfg(target_os="macos")]
pub fn open_terminal(provider: Provider, action: Action) -> bool {
    // Temporary handoff scripts are kept for inspection, never auto-deleted
    // while Terminal could still be opening them. No auth data is stored.
    let mut entropy = [0u8;16];
    if getrandom::fill(&mut entropy).is_err() { return false; }
    let suffix: String = entropy.iter().map(|byte| format!("{byte:02x}")).collect();
    let directory = std::env::temp_dir().join(format!("orcode-manufacturer-{suffix}"));
    if fs::create_dir(&directory).is_err() { return false; }
    if fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).is_err() { return false; }
    let path = directory.join("Hersteller-CLI.command");
    let Ok(mut file) = OpenOptions::new().write(true).create_new(true).mode(0o700).open(&path) else { return false; };
    if file.write_all(script(provider, action).as_bytes()).is_err() || file.sync_all().is_err() { return false; }
    Command::new("/usr/bin/open").args(["-a", "Terminal"]).arg(&path)
        .status().is_ok_and(|status| status.success())
}

#[cfg(not(target_os="macos"))]
pub fn open_terminal(_provider: Provider, _action: Action) -> bool { false }
