// @vitest-environment jsdom
import {test,expect,vi} from 'vitest';
import {officialCliPanel} from '../src/official-cli-panel.js';
test('CLI actions are explicit and do not auto-login or imply GUI readiness',()=>{
  const action = vi.fn();
  const panel = officialCliPanel({},true,false,action);
  expect(action).not.toHaveBeenCalled();
  expect(panel.textContent).toContain('Claude Code');
  expect(panel.textContent).toContain('Kimi Code');
  const login = [...panel.querySelectorAll('button')].find(b=>b.textContent==='Anmelden')!;
  login.click();
  expect(action).toHaveBeenCalledWith('codex','login');
});
test('missing native shell disables install/login, check remains available',()=>{
  const action = vi.fn();
  const panel = officialCliPanel({},false,false,action);
  const login = [...panel.querySelectorAll('button')].find(b=>b.textContent==='Anmelden')!;
  expect(login.disabled).toBe(true);
  expect(panel.textContent).toContain('Prüfen');
});
test('a native shell without verified setup authority is not mislabeled as a missing desktop app',()=>{
  const panel=officialCliPanel({codex:{kind:'checked',nativeAvailable:false,
    state:{provider:'codex',version:'0.159.1',installed:'yes',authenticated:'yes',runnableInGui:'no'},
    presentation:{ready:false,reason:'GUI-Adapter fehlt',label:'Hersteller-Terminal',action:'open-external'}}},false,false,vi.fn());
  expect(panel.textContent).toContain('Einrichtungsfreigabe');
  expect(panel.textContent).not.toContain('benötigen die lokale Desktop-App');
});
