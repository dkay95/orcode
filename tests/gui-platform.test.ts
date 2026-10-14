import {test} from 'node:test';
import assert from 'node:assert/strict';
import {guiPlatform,resolveNpmInvocation,withGuiPath} from '../scripts/gui-platform.mjs';

test('Windows build uses native runtime and PATH separators without HOME',()=>{
  const result=guiPlatform('win32','x64','C:\\Users\\Test User','C:\\Windows\\System32');
  assert.deepEqual(result,{
    nodeName:'node.exe',pathValue:'C:\\Users\\Test User\\.cargo\\bin;C:\\Windows\\System32',
    bundles:['nsis'],runtimeSupported:true,
  });
});

test('unsupported Windows architecture cannot select a supported bundled runtime',()=>{
  assert.equal(guiPlatform('win32','arm64','C:\\Users\\Test','').runtimeSupported,false);
  assert.equal(guiPlatform('linux','x64','/fixture','/usr/bin').runtimeSupported,false);
});

test('Mac build keeps its cargo PATH and app/DMG targets',()=>{
  assert.deepEqual(guiPlatform('darwin','arm64','/Users/Test User','/usr/bin:/bin'),{
    nodeName:'node',pathValue:'/Users/Test User/.cargo/bin:/usr/bin:/bin',
    bundles:['app','dmg'],runtimeSupported:true,
  });
});

test('npm is invoked through the chosen Node executable and JS entrypoint',()=>{
  assert.deepEqual(resolveNpmInvocation('C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',()=>true,'win32'),{
    command:'C:\\Program Files\\nodejs\\node.exe',
    args:['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'],
  });
});

test('direct script invocation can resolve adjacent npm but never npm.cmd from PATH',()=>{
  const expected='C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
  assert.deepEqual(resolveNpmInvocation('C:\\Program Files\\nodejs\\node.exe',undefined,
    path=>path===expected,'win32'),{
    command:'C:\\Program Files\\nodejs\\node.exe',args:[expected],
  });
  assert.throws(()=>resolveNpmInvocation('C:\\node.exe','C:\\untrusted\\npm.cmd',()=>false,'win32'),
    /npm JavaScript entrypoint/);
});

test('Windows build PATH cannot coexist with an inherited case alias',()=>{
  const result=withGuiPath({Path:'old',PATH:'other',SystemRoot:'C:\\Windows'},'new','win32');
  assert.deepEqual(result,{SystemRoot:'C:\\Windows',PATH:'new'});
  assert.deepEqual(withGuiPath({Path:'separate',PATH:'old'},'new','darwin'),{
    Path:'separate',PATH:'new',
  });
});
