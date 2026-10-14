import { emptyOfficialCliState, type CliFact, type OfficialCliId, type OfficialCliState } from './official-cli-state.js';

/** Implemented by a trusted native/runtime boundary, not supplied by a model or WebView. */
export interface OfficialCliProbePort {
  inspectInstallation(provider: OfficialCliId, signal: AbortSignal): Promise<{
    readonly installed: boolean | null;
    readonly version: string | null;
    readonly compatible: boolean | null;
  }>;
  inspectAccount(provider: OfficialCliId, signal: AbortSignal): Promise<{
    readonly authenticated: boolean | null;
    readonly subscription: boolean | null;
    readonly runnableInGui: boolean | null;
  }>;
}

const fact = (value: boolean | null): CliFact => value === true ? 'yes' : value === false ? 'no' : 'unknown';

/**
 * A bounded, cancellable observation, never login/install/inference. Ports own
 * executable trust and closed argv. This layer publishes only public facts.
 * Even a port that ignores cancellation cannot publish a late success.
 */
export async function probeOfficialCli(
  provider: OfficialCliId,
  revision: number,
  port: OfficialCliProbePort,
  options: {readonly timeoutMs?: number; readonly signal?: AbortSignal} = {},
): Promise<OfficialCliState> {
  const initial = emptyOfficialCliState(provider, revision);
  const timeoutMs = options.timeoutMs ?? 4_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error('invalid-cli-deadline');
  }
  if (options.signal?.aborted) return {...initial, outcome:'cancelled'};
  const controller = new AbortController();
  let state = initial;
  let rejectAbort!: (reason: Error) => void;
  const abortPromise = new Promise<never>((_resolve, reject) => {rejectAbort=reject;});
  const onAborted = () => rejectAbort(new Error('cli-check-retired'));
  const onParentAborted = () => controller.abort();
  controller.signal.addEventListener('abort', onAborted, {once:true});
  options.signal?.addEventListener('abort', onParentAborted, {once:true});
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const assertCurrent = () => {
    if (controller.signal.aborted) throw new Error('cli-check-retired');
  };
  const inspect = async (): Promise<OfficialCliState> => {
    const installation = await port.inspectInstallation(provider, controller.signal);
    assertCurrent();
    const version = typeof installation.version === 'string'
      && /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-zA-Z0-9.-]{1,64})?$/.test(installation.version)
      ? installation.version : null;
    state = {...state, installed:fact(installation.installed), version,
      compatible:version === null ? 'unknown' : fact(installation.compatible)};
    if (state.installed !== 'yes' || state.compatible !== 'yes') {
      return {...state, runnableInGui:state.installed === 'unknown' ? 'unknown' : 'no'};
    }
    const account = await port.inspectAccount(provider, controller.signal);
    assertCurrent();
    const authenticated = fact(account.authenticated);
    const subscription = authenticated === 'yes' ? fact(account.subscription) : 'unknown';
    return {...state, authenticated, subscription,
      runnableInGui:authenticated === 'yes' && subscription === 'yes'
        ? fact(account.runnableInGui) : 'no'};
  };
  try {
    return await Promise.race([inspect(), abortPromise]);
  } catch {
    return {...state, outcome:options.signal?.aborted ? 'cancelled' : 'failed',
      authenticated:'unknown', subscription:'unknown', runnableInGui:'unknown'};
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onParentAborted);
    controller.signal.removeEventListener('abort', onAborted);
  }
}
