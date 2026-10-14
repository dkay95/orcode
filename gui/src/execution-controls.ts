import {el} from './dom.js';
export interface LocalWorkbenchState {
  active?:boolean;
  policy:{aiProcess:'manual'|'auto';permissions:'ask'|'automatic';revision:number};
  candidate:null|{id:string;candidateHandle:string;phase:string;originalWorkspace:string;
    changes:readonly {path:string;kind:string}[];tested:boolean};
}
export function executionControls(state:LocalWorkbenchState,busy:boolean,handlers:{
  change(key:'aiProcess'|'permissions',value:string):void;stop():void;}):HTMLElement {
  const row=el('div',{class:'execution-controls',role:'group','aria-label':'Ausführung'});
  for(const [key,title,choices] of [
    ['aiProcess','AI-Prozess',[['manual','Manuell'],['auto','Auto · Plan → Umsetzung']]],
    ['permissions','Permissions',[['ask','Nachfragen'],['automatic','Automatisch']]],
  ] as const) {
    const select=el('select',{name:key,'aria-label':title,disabled:busy}) as HTMLSelectElement;
    for(const [value,text] of choices)select.append(el('option',{value,text}));
    select.value=state.policy[key];select.addEventListener('change',()=>handlers.change(key,select.value));
    row.append(el('label',{class:'execution-control'},[el('span',{text:title}),select]));
  }
  const stop=el('button',{class:'btn ghost danger',type:'button',text:'Stop',
    disabled:!busy && (!state.candidate||['stopped','applied'].includes(state.candidate.phase))}) as HTMLButtonElement;
  stop.addEventListener('click',handlers.stop);row.append(stop);
  row.title='Auto plant vor der Umsetzung mit deinem gewählten Lead. Automatische Permissions erlauben Dateiänderungen in der Arbeitskopie; geschützte Aktionen und Übernahme benötigen weiterhin Freigaben.';
  return row;
}
export function candidatePanel(state:LocalWorkbenchState,busy:boolean,
  action:(value:'test'|'apply'|'resume')=>void):HTMLElement {
  const panel=el('section',{class:'candidate-panel','aria-label':'Arbeitskopie'});
  const candidate=state.candidate;if(!candidate){panel.hidden=true;return panel;}
  const labels:Record<string,string>={prepared:'Vorbereitet',running:'In Arbeit',review:'Prüfung ausstehend',
    'awaiting-apply':'Geprüft · bereit zur Übernahme',applied:'Übernommen',blocked:'Blockiert',stopped:'Gestoppt'};
  panel.append(el('strong',{text:`Arbeitskopie · ${labels[candidate.phase]??candidate.phase}`}),
    el('span',{class:'muted',text:candidate.phase==='applied'?'Änderungen im Original gespeichert.':
      `Original unverändert · ${candidate.changes.length} geänderte Dateien`}));
  const actions=el('div',{class:'actions'});
  for(const [value,text,disabled] of [
    ['test','Prüfen',busy||candidate.phase==='stopped'||candidate.phase==='applied'],
    ['apply','Übernehmen',busy||!candidate.tested||candidate.phase!=='awaiting-apply'],
    ...(candidate.phase==='stopped'?[['resume','Fortsetzen',busy]]:[]),
  ] as [string,string,boolean][]) {
    const button=el('button',{class:value==='apply'?'btn primary':'btn ghost',type:'button',text,disabled}) as HTMLButtonElement;
    button.addEventListener('click',()=>action(value as 'test'|'apply'|'resume'));actions.append(button);
  }
  panel.append(actions);return panel;
}
