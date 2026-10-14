/** Public manufacturer-CLI facts. No process output, paths, identity or tokens. */
export const OFFICIAL_CLI_IDS = ['codex', 'claude', 'kimi'] as const;
export type OfficialCliId = (typeof OFFICIAL_CLI_IDS)[number];
export type CliFact = 'yes' | 'no' | 'unknown';
export type OfficialCliAction = 'check' | 'install' | 'login' | 'open-external';
export interface OfficialCliState {
  readonly provider: OfficialCliId;
  readonly installed: CliFact;
  readonly version: string | null;
  readonly compatible: CliFact;
  readonly authenticated: CliFact;
  readonly subscription: CliFact;
  readonly runnableInGui: CliFact;
  readonly revision: number;
  readonly outcome: 'checked' | 'cancelled' | 'failed';
}

export function emptyOfficialCliState(provider: OfficialCliId, revision: number): OfficialCliState {
  if (!OFFICIAL_CLI_IDS.includes(provider) || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('invalid-cli-observation');
  }
  return {provider, revision, installed:'unknown', version:null, compatible:'unknown',
    authenticated:'unknown', subscription:'unknown', runnableInGui:'unknown', outcome:'checked'};
}

export function cliReady(state: OfficialCliState): boolean {
  return state.outcome === 'checked' && [state.installed, state.compatible,
    state.authenticated, state.subscription, state.runnableInGui].every(value => value === 'yes');
}

export function acceptCliObservation(current: OfficialCliState, observed: OfficialCliState): OfficialCliState {
  if (current.provider !== observed.provider || current.revision !== observed.revision
    || observed.outcome === 'cancelled') return current;
  return observed;
}

export function cliPresentation(state: OfficialCliState): {
  readonly ready: boolean;
  readonly action: OfficialCliAction;
  readonly label: string;
  readonly reason: string;
} {
  if (cliReady(state)) return {ready:true, action:'check', label:'Verbunden', reason:'CLI und GUI-Verbindung sind geprüft.'};
  if (state.installed === 'no') return {ready:false, action:'install', label:'CLI installieren', reason:'Die Hersteller-CLI wurde nicht gefunden.'};
  if (state.installed !== 'yes' || state.outcome === 'failed') {
    return {ready:false, action:'check', label:'CLI prüfen', reason:'Installation und Verbindung sind noch nicht bestätigt.'};
  }
  if (state.compatible === 'no') {
    return {ready:false, action:'open-external', label:'Hersteller-Terminal öffnen', reason:'Diese CLI-Version ist noch nicht für die GUI freigegeben.'};
  }
  if (state.authenticated === 'no') {
    return {ready:false, action:'login', label:'Beim Hersteller anmelden', reason:'Die CLI ist installiert; die Anmeldung fehlt.'};
  }
  if (state.authenticated === 'yes' && (state.subscription === 'no' || state.runnableInGui === 'no')) {
    return {ready:false, action:'open-external', label:'Hersteller-Terminal öffnen', reason:state.subscription === 'no'
      ? 'Ein nutzbares Abo wurde nicht bestätigt. Es wird kein API-Fallback gestartet.'
      : 'Die CLI ist angemeldet; ein GUI-Ausführungsadapter ist noch nicht verfügbar.'};
  }
  return {ready:false, action:'check', label:'CLI prüfen', reason:'Version, Anmeldung oder Abo-Nutzung sind noch nicht vollständig geprüft.'};
}
