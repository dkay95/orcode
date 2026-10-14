// @vitest-environment jsdom
import {test,expect,vi} from 'vitest';
import {executionControls,candidatePanel} from '../src/execution-controls.js';
const state={policy:{aiProcess:'manual',permissions:'ask',revision:1},candidate:null} as const;
test('two separate controls dispatch only their own key, not a model choice',()=>{
  const change=vi.fn(),stop=vi.fn();
  const root=executionControls(state,false,{change,stop});
  const select=root.querySelector<HTMLSelectElement>('[name="aiProcess"]')!;
  select.value='auto';select.dispatchEvent(new Event('change'));
  expect(change).toHaveBeenCalledWith('aiProcess','auto');
  expect(root.querySelector<HTMLSelectElement>('[name="permissions"]')!.value).toBe('ask');
  expect(root.textContent).not.toContain('Modell automatisch');
});
test('Apply remains unavailable until the exact candidate is tested',()=>{
  const action=vi.fn();
  const candidate={id:'run',candidateHandle:'candidate',phase:'review',originalWorkspace:'/project',
    changes:[{path:'a.ts',kind:'update'}],tested:false} as const;
  const root=candidatePanel({...state,candidate},false,action);
  expect([...root.querySelectorAll('button')].find(b=>b.textContent==='Übernehmen')!.disabled).toBe(true);
  expect(root.textContent).toContain('Original unverändert');
});
