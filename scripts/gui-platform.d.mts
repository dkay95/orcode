export function guiPlatform(platform:string,arch:string,home:string,pathValue:string):{
  nodeName:string;pathValue:string;bundles:string[];runtimeSupported:boolean;
};
export function resolveNpmInvocation(nodePath:string,npmExecPath:string|undefined,
  exists:(path:string)=>boolean,platform:string):{command:string;args:string[]};
export function withGuiPath(environment:NodeJS.ProcessEnv,pathValue:string,platform:string):NodeJS.ProcessEnv;
