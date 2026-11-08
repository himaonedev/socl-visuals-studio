import { fireEvent, screen } from '@testing-library/react';
import logic from '../../src/caption-extras.js?raw';
import ui from '../../src/caption-extras-ui.js?raw';

it('adds motion inside the existing caption panel without changing SOCL style or opening another workspace', async () => {
  new Function('window',logic)(window);
  new Function('window',ui)(window);
  let nextFrame: FrameRequestCallback = () => {};
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { nextFrame=fn;return 1; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const api=(window as any).CaptionExtrasUI;
  document.body.innerHTML=`<div id="stage"><div id="overlay" style="color:rgb(255, 255, 0)"></div></div><div id="panel">${api.html()}</div>`;
  const tokens=[{text:'Tetap',style:{font:'Anton',color:'#ffff00'}}];
  const cue:any={start:0,end:2,text:'Tetap SOCL',tokens};
  const changed=vi.fn(),persist=vi.fn(async()=>{}),navigate=vi.fn();
  window.addEventListener('socl-open-effects',navigate);
  const context={
    stage:document.getElementById('stage'),overlay:document.getElementById('overlay'),cues:()=>[cue],time:()=>.2,activeIndex:()=>0,selection:()=>[0],hidden:()=>false,capture:()=>[],signature:()=>'',changed,persist,
  };
  const dispose=api.mount(document.getElementById('panel'),context);
  nextFrame(0);
  fireEvent.change(screen.getByLabelText('Motion teks'),{target:{value:'rise'}});
  fireEvent.change(screen.getByLabelText('Kedap-kedip'),{target:{value:'pulse'}});
  fireEvent.click(screen.getByRole('button',{name:'Terapkan',exact:true}));
  expect(cue.textMotion.motion).toBe('rise');
  expect(cue.textMotion.flicker).toBe('pulse');
  expect(cue.tokens).toBe(tokens);
  expect(document.getElementById('overlay')!.style.color).toBe('rgb(255, 255, 0)');
  expect(changed).toHaveBeenCalledOnce();
  expect(persist).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
  dispose();
  document.getElementById('panel')!.innerHTML=api.html();
  const disposeReopened=api.mount(document.getElementById('panel'),context);
  nextFrame(0);
  expect(screen.getByLabelText('Motion teks')).toHaveValue('rise');
  expect(screen.getByLabelText('Kedap-kedip')).toHaveValue('pulse');
  expect(cue.tokens).toBe(tokens);
  disposeReopened(); window.removeEventListener('socl-open-effects',navigate);vi.unstubAllGlobals();
});
