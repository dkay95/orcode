import {win32,posix} from 'node:path';

/** Build decisions only: this does not attest runtime execution support. */
export function guiPlatform(platform,arch,home,pathValue) {
  const windows=platform==='win32';
  const paths=windows?win32:posix;
  const cargo=paths.join(home,'.cargo','bin');
  return {
    nodeName:windows?'node.exe':'node',
    pathValue:[cargo,pathValue].filter(Boolean).join(windows?';':':'),
    bundles:windows?['nsis']:['app','dmg'],
    runtimeSupported:platform==='darwin'||(windows&&arch==='x64'),
  };
}

/** Never route npm through a .cmd shim or an implicitly selected shell. */
export function resolveNpmInvocation(nodePath,npmExecPath,exists,platform) {
  const paths=platform==='win32'?win32:posix;
  const bin=paths.dirname(nodePath);
  const candidates=[
    npmExecPath,
    paths.join(bin,'node_modules','npm','bin','npm-cli.js'),
    paths.join(bin,'..','lib','node_modules','npm','bin','npm-cli.js'),
  ];
  const entry=candidates.find(path=>typeof path==='string'
    && paths.isAbsolute(path)&&paths.basename(path)==='npm-cli.js'&&exists(path));
  if(!entry)throw new Error('The npm JavaScript entrypoint was not found. Run through npm or install its Node distribution.');
  return {command:nodePath,args:[entry]};
}

/** Windows environment names are case-insensitive; emit one PATH only. */
export function withGuiPath(environment,pathValue,platform) {
  const result={...environment};
  if(platform==='win32') {
    for(const key of Object.keys(result))if(key.toUpperCase()==='PATH')delete result[key];
  }
  return {...result,PATH:pathValue};
}
