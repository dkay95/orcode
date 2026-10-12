import { consumeCurrentKimiPackagedRuntimeAttestation, hasCurrentKimiPackagedRuntimeAttestation, matchesCurrentKimiPackagedRuntimeAttestation, type KimiDesktopPermitReader } from "./kimi-desktop-permit.js";
import type { NativeLocalActionRequirement } from "./desktop-contracts.js";

export interface LocalInteractiveOwnerAuthority {
  readonly kind: "local-interactive-owner";
  assertCurrent(): void | Promise<void>;
}

/**
 * Latent Task-4 carrier. Task 5 is the only production minter; Task 4 merely
 * accepts an already-attested instance through internal bootstrap injection.
 */
export interface DesktopKimiRuntimeCapability {
  readonly kind: "desktop-kimi-runtime-capability";
  readonly permitReader: KimiDesktopPermitReader;
  readonly childPid: number;
  readonly generation: number;
  readonly now: () => number;
  readonly emitRequirement: (
    requirement: NativeLocalActionRequirement,
  ) => void | Promise<void>;
}

const MINTED_DESKTOP_KIMI_CAPABILITIES = new WeakSet<object>();
const DESKTOP_KIMI_BINDINGS = new WeakMap<object, Readonly<{
  permitReader: KimiDesktopPermitReader;
  childPid: number;
  generation: number;
}>>();

export function createDesktopKimiRuntimeCapability(
  attestation: unknown,
  value: Omit<DesktopKimiRuntimeCapability, "kind">,
): DesktopKimiRuntimeCapability {
  if (!exactOwnDataObject(value, ["permitReader", "childPid", "generation", "now", "emitRequirement"])) {
    throw new TypeError("The packaged runtime capability is invalid.");
  }
  if (!hasCurrentKimiPackagedRuntimeAttestation(attestation)) throw new TypeError("A current packaged runtime attestation is required.");
  if (!matchesCurrentKimiPackagedRuntimeAttestation(attestation, value.permitReader, value.childPid, value.generation)) {
    throw new TypeError("The packaged runtime attestation does not match this capability.");
  }
  const capability = Object.freeze({
    kind: "desktop-kimi-runtime-capability" as const,
    permitReader: value.permitReader,
    childPid: value.childPid,
    generation: value.generation,
    now: value.now,
    emitRequirement: value.emitRequirement,
  });
  consumeCurrentKimiPackagedRuntimeAttestation(attestation);
  MINTED_DESKTOP_KIMI_CAPABILITIES.add(capability);
  DESKTOP_KIMI_BINDINGS.set(capability, Object.freeze({
    permitReader: value.permitReader,
    childPid: value.childPid,
    generation: value.generation,
  }));
  if (!isDesktopKimiRuntimeCapability(capability)) throw new TypeError("A current packaged runtime capability is required.");
  return capability;
}

export function isDesktopKimiRuntimeCapability(
  value: unknown,
): value is DesktopKimiRuntimeCapability {
  if (typeof value !== "object" || value === null) return false;
  if (!exactOwnDataObject(value, ["kind", "permitReader", "childPid", "generation", "now", "emitRequirement"])) return false;
  const candidate = value as Partial<DesktopKimiRuntimeCapability>;
  const binding = DESKTOP_KIMI_BINDINGS.get(value);
  return MINTED_DESKTOP_KIMI_CAPABILITIES.has(value)
    && candidate.kind === "desktop-kimi-runtime-capability"
    && candidate.permitReader !== undefined
    && candidate.permitReader.isOpen
    && Number.isSafeInteger(candidate.childPid)
    && candidate.childPid === process.pid
    && Number.isSafeInteger(candidate.generation)
    && Number(candidate.generation) >= 0
    && typeof candidate.now === "function"
    && typeof candidate.emitRequirement === "function"
    && binding?.permitReader === candidate.permitReader
    && binding.childPid === candidate.childPid
    && binding.generation === candidate.generation;
}

function exactOwnDataObject(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && keys.every((key) => typeof key === "string"
      && expected.includes(key)
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && "value" in Object.getOwnPropertyDescriptor(value, key)!);
}

export type KimiExecutionOrigin =
  | Readonly<{ kind: "terminal-local"; ownerAuthority: LocalInteractiveOwnerAuthority }>
  | Readonly<{ kind: "desktop-native"; permitReader: KimiDesktopPermitReader }>;

export function terminalLocalKimiExecutionOrigin(
  ownerAuthority: LocalInteractiveOwnerAuthority,
): Extract<KimiExecutionOrigin, { kind: "terminal-local" }> {
  if (!ownerAuthority
    || ownerAuthority.kind !== "local-interactive-owner"
    || typeof ownerAuthority.assertCurrent !== "function") {
    throw new TypeError("A verified local interactive owner authority is required.");
  }
  return Object.freeze({ kind: "terminal-local", ownerAuthority });
}

export function desktopNativeKimiExecutionOrigin(
  permitReader: KimiDesktopPermitReader,
): Extract<KimiExecutionOrigin, { kind: "desktop-native" }> {
  if (!permitReader || !permitReader.isOpen) {
    throw new TypeError("A live desktop Kimi permit reader is required.");
  }
  return Object.freeze({ kind: "desktop-native", permitReader });
}

export async function visitKimiExecutionOrigin<T>(
  origin: KimiExecutionOrigin,
  visitor: Readonly<{
    terminal(authority: LocalInteractiveOwnerAuthority): T | Promise<T>;
    desktop(reader: KimiDesktopPermitReader): T | Promise<T>;
  }>,
): Promise<T> {
  if (!origin || !visitor) throw new TypeError("A closed Kimi execution origin is required.");
  if (origin.kind === "terminal-local") return visitor.terminal(origin.ownerAuthority);
  if (origin.kind === "desktop-native") {
    if (!origin.permitReader.isOpen) throw new TypeError("The desktop Kimi permit reader is closed.");
    return visitor.desktop(origin.permitReader);
  }
  throw new TypeError("A closed Kimi execution origin is required.");
}
