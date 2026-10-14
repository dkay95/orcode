import {el} from './dom.js';
export type Manufacturer = 'codex'|'claude'|'kimi';
export type ManufacturerAction = 'check'|'install'|'login'|'open-external';
export interface ManufacturerObservation {
  kind:'checked'; nativeAvailable:boolean;
  state:{provider:Manufacturer;version:string|null;installed:'yes'|'no'|'unknown';
    authenticated:'yes'|'no'|'unknown';runnableInGui:'yes'|'no'|'unknown'};
  presentation:{ready:boolean;reason:string;label:string;action:ManufacturerAction};
}
export function officialCliPanel(states:Partial<Record<Manufacturer,ManufacturerObservation>>,
  nativeAvailable:boolean, busy:boolean, action:(provider:Manufacturer,action:ManufacturerAction)=>void):HTMLElement {
  const panel = el('section',{class:'manufacturer-panel'});
  panel.append(el('h3',{text:'Deine Hersteller-Abos'}),el('p',{class:'muted',
    text:'Installation, Anmeldung und GUI-Verbindung werden getrennt geprüft. Dein Modell wählst du danach selbst.'}));
  for (const [provider,label] of [['codex','ChatGPT / Codex'],['claude','Claude Code'],['kimi','Kimi Code']] as const) {
    const observation = states[provider];
    const row = el('div',{class:'manufacturer-row'});
    row.append(el('strong',{text:label}),el('span',{class:'muted',text:observation
      ? `${observation.state.version ?? 'Version ungeprüft'} · ${observation.presentation.reason}` : 'Noch nicht geprüft'}));
    const actions = el('div',{class:'actions'});
    const choices:readonly [ManufacturerAction,string][] = [
      ['check','Prüfen'],[observation?.state.installed === 'no' ? 'install' : 'login',
        observation?.state.installed === 'no' ? 'Installieren' : 'Anmelden'],['open-external','Hersteller-Terminal']];
    for (const [value,text] of choices) {
      const button = el('button',{class:'btn ghost',type:'button',text,
        disabled:busy || (value !== 'check' && !nativeAvailable)}) as HTMLButtonElement;
      button.addEventListener('click',()=>action(provider,value));
      actions.append(button);
    }
    row.append(actions); panel.append(row);
  }
  if (!nativeAvailable) panel.append(el('p',{class:'muted',text:Object.keys(states).length
    ? 'Diese App hat noch keine bestätigte native Einrichtungsfreigabe. Installation und Anmeldung sind deshalb hier gesperrt; deine bestehende CLI-Anmeldung bleibt unverändert.'
    : 'Wähle zuerst „Prüfen“. Installation und Anmeldung werden nur mit bestätigter nativer Einrichtungsfreigabe angeboten.'}));
  return panel;
}
