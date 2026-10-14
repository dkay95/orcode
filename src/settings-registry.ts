import { ANTHROPIC_DIRECT_BACKEND_NOTICE } from "./backends.js";
import type { ProviderCommandBackendId } from "./commands.js";
import type { OrcodeConfigWithBudget } from "./config.js";
import type { OrcodeConfig } from "./types.js";
import type { RouteIdentityV1 } from "./backends.js";
import { architectUnavailableReasonForRoute } from "./architect.js";
import {
  DEFAULT_REASONING_SETTING,
  getReasoningSetting,
  reasoningChoiceValue,
  reasoningChoices,
  reasoningLabel,
  supportsReasoning,
} from "./reasoning.js";
import type { CostKnowledge, ModelInfo } from "./types.js";
import { formatUsd, lookupTable, pluralize } from "./utils.js";

export const SETTINGS_CATEGORY_IDS = [
  "models",
  "accounts",
  "approvals-costs",
  "tools",
  "appearance",
] as const;

export type SettingsCategoryId = (typeof SETTINGS_CATEGORY_IDS)[number];

export const SETTINGS_ACTION_IDS = [
  "main-model",
  "reasoning",
  "reasoning-compressor",
  "reasoning-cross-lead",
  "reasoning-cross-challenger",
  "compression-mode",
  "compressor-model",
  "max-steps",
  "provider-setup",
  "provider-connect",
  "provider-enable",
  "provider-disable",
  "provider-disconnect",
  "provider-reconnect",
  "provider-models",
  "provider-logout",
  "provider-sort",
  "provider-data-collection",
  "provider-only",
  "provider-ignore",
  "provider-fallback",
  "approval-mode",
  "approval-forget",
  "approval-forget-all",
  "max-cost",
  "compressor-max-cost",
  "low-balance-threshold",
  "budget-daily",
  "budget-total",
  "budget-on-exceed",
  "verify-mode",
  "verify-commands",
  "verify-suggest",
  "verify-clear",
  "verify-repair-rounds",
  "web-mode",
  "browser-path",
  "browser-timeout",
  "panel-models",
  "panel-judge",
  "transcription-model",
  "voice-consent-clear",
  "appearance-large-logo",
  "appearance-header-mark",
  "appearance-glyph-mode",
  "cross-lead-model",
  "cross-challenger-model",
  "cross-pair-swap",
  "architect-executor-model",
] as const satisfies readonly string[];

export type SettingsActionId = (typeof SETTINGS_ACTION_IDS)[number];

export type ProviderBackendAction =
  | "connect"
  | "enable"
  | "disable"
  | "disconnect"
  | "reconnect"
  | "models"
  | "logout";

export type SettingsItemId =
  | SettingsActionId
  | "cost-summary"
  | "voice-consent-status"
  | "security-provider-data-collection"
  | "security-provider-only"
  | "security-provider-ignore"
  | `provider-status:${ProviderCommandBackendId}`
  | `provider-action:${ProviderCommandBackendId}:${ProviderBackendAction}`
  | `approval-rule:${string}`
  | `approval-forget:${string}`;

export interface SettingsChoice {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

export type SettingsEditorDescriptor =
  | {
      readonly kind: "choice";
      readonly actionId: SettingsActionId;
      readonly options: readonly SettingsChoice[];
    }
  | {
      readonly kind: "model";
      readonly actionId: SettingsActionId;
      readonly filter: "main" | "compressor" | "panel" | "audio-input" | "cross-lead" | "cross-challenger" | "architect-executor";
      readonly multiple?: boolean;
    }
  | {
      readonly kind: "number";
      readonly actionId: SettingsActionId;
      readonly minimum: number;
      readonly maximum: number;
      readonly allowOff?: boolean;
      readonly unit?: string;
    }
  | {
      readonly kind: "text";
      readonly actionId: SettingsActionId;
      readonly valueKind: "path" | "command-list" | "provider-list";
    }
  | {
      readonly kind: "confirm";
      readonly actionId: SettingsActionId;
      readonly destructive: boolean;
    }
  | { readonly kind: "invoke"; readonly actionId: SettingsActionId }
  | { readonly kind: "readonly" };

export interface SettingsItem {
  readonly id: SettingsItemId;
  readonly categoryId: SettingsCategoryId;
  readonly label: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly displayValue: string;
  readonly editor: SettingsEditorDescriptor;
  /** False only for status and presentation-only actions such as Appearance. */
  readonly affectsActiveRun: boolean;
  readonly disabledReason?: "Run active" | string;
  /**
   * V4-B: the heading this row sits under in its category's dense list
   * (`─ Cross pair`, level 2 — the owner-approved mockup draws exactly this).
   *
   * A grouping, never a level: it changes nothing about navigation, search,
   * ids or persistence, and the frame renders a heading only where the
   * section CHANGES between two consecutive rows of the same category. Rows
   * carrying a section are contiguous by construction (`inSection` wraps the
   * builder's own sub-arrays), so the heading order is the row order.
   *
   * Unset means "this category has no natural groups" — Appearance's three
   * rows are one idea and get no heading rather than an invented one. The
   * rule is per category: `tests/settings-registry.test.ts` pins that a
   * category either sections ALL of its rows or none of them, so a new row
   * cannot slip in unheaded under a heading that does not describe it.
   */
  readonly section?: string;
}

export interface SettingsCategory {
  readonly id: SettingsCategoryId;
  readonly label: string;
  readonly description: string;
}

export interface SettingsRegistry {
  readonly categories: readonly SettingsCategory[];
  readonly items: readonly SettingsItem[];
}

export interface SettingsRouteProjection {
  readonly backendId: ProviderCommandBackendId;
  readonly providerLabel: string;
  readonly requestedModelId: string;
  readonly canonicalModelId: string;
  readonly modelLabel: string;
  readonly billingRealm:
    | "openrouter-payg"
    | "kimi-code-membership-provider-managed-overage"
    | "nanogpt-subscription"
    | "nanogpt-payg"
    | "none";
}

export interface SettingsProviderHealthProjection {
  readonly credential:
    | "valid"
    | "rejected"
    | "expired"
    | "login-required"
    | "unknown"
    | "not-applicable";
  readonly connectivity: "connected" | "offline" | "unknown";
  readonly spend: "available" | "limit-reached" | "unknown";
  readonly runtime:
    | "ready"
    | "missing"
    | "incompatible"
    | "policy-unavailable"
    | "not-applicable";
}

export type SettingsProviderHeadline =
  | "ready"
  | "login-required"
  | "auth-rejected"
  | "credential-expired"
  | "offline"
  | "limit-reached"
  | "runtime-missing"
  | "incompatible-runtime"
  | "policy-unavailable"
  | "unknown";

/**
 * Safe cached provider view. Lifecycle capabilities arrive from the provider
 * command authority; this module deliberately owns no backend capability map.
 */
export interface SettingsProviderProjection {
  readonly backendId: ProviderCommandBackendId;
  readonly displayName: string;
  readonly availability: "connectable" | "coming-soon";
  /** FIX-10 fix round 1 (F1): tri-state — see `ProviderCommandStatusEntry.configuration` (commands.ts). */
  readonly configuration: "enabled" | "disabled" | "not-connected";
  readonly maturity: "stable" | "preview" | "coming-soon";
  readonly billingRealm:
    | "openrouter-payg"
    | "kimi-code-membership-provider-managed-overage"
    | "nanogpt-subscription"
    | "nanogpt-payg"
    | "none";
  readonly headline: SettingsProviderHeadline | null;
  readonly health: SettingsProviderHealthProjection | null;
  readonly isDefault: boolean;
  readonly selectedModel: {
    readonly requestedModelId: string;
    readonly canonicalModelId: string;
    readonly displayName: string;
  } | null;
  readonly allowedActions: readonly ProviderBackendAction[];
}

export interface SettingsApprovalRuleProjection {
  readonly id: string;
  readonly decision: "allow" | "deny";
}

export interface SettingsCostProjection {
  readonly costKnowledge: CostKnowledge;
  readonly sessionUsd: number;
  readonly dayUsd: number;
  readonly totalUsd: number;
}

/**
 * A configured route as Settings is allowed to hold it: the single field
 * every Settings row renders for a route. The stored value is always a
 * `RouteIdentityV1` (config.ts / collaboration.ts), which also carries
 * `accountFingerprint` — an HMAC of the credential (backends.ts) that
 * Settings state must never hold. Same reduction
 * `SettingsProviderProjection.selectedModel` already applies to a route; a
 * full `RouteIdentityV1` still satisfies this shape, so the authoritative
 * value can be read directly and reduced at the projection boundary.
 */
export interface SettingsRouteModelProjection {
  readonly requestedModelId: string;
}

/**
 * The Architect executor route as Settings is allowed to hold it (F1): the
 * one field `architectExecutorDisplay` below renders, nothing else.
 */
export type SettingsArchitectExecutorProjection = SettingsRouteModelProjection;

/**
 * Cross's lead/challenger pair as Settings is allowed to hold it (F1b). The
 * runtime pair is a `CrossPreferencesV1` (collaboration.ts) — two whole
 * `RouteIdentityV1`s — and every Settings consumer of it (`crossRoleDisplay`,
 * `crossSwapDisabledReason`, the reasoning rows, `initialValue`) reads only
 * the model id and whether the role is set at all. The picker's identity
 * `exclude` used to be the one real consumer of the rest; it is now resolved
 * runtime-side instead (see `SettingsEditorRequest.excludeCrossRole`).
 */
export interface SettingsCrossPreferencesProjection {
  readonly lead: SettingsRouteModelProjection | null;
  readonly challenger: SettingsRouteModelProjection | null;
}

/**
 * Safe Cross default-pair view. `providerSetup` (where the pair actually
 * persists) is stripped from the Settings config path, so this is the only
 * way the registry may learn the stored or staged lead/challenger pair — and
 * it learns it as two model ids, never as two route identities.
 */
export interface SettingsCrossProjection {
  readonly preferences: SettingsCrossPreferencesProjection;
  readonly available: boolean;
  readonly unavailableReason?: string;
}

/**
 * The config as the registry consumes it: everything `OrcodeConfigWithBudget`
 * has, minus the executor route's identity fields. Nothing in the registry
 * ever needed them (the row prints a model id), so the narrower type is what
 * both the authoritative config and `SettingsConfigProjection` satisfy.
 */
export type SettingsRegistryConfig =
  & Omit<OrcodeConfigWithBudget, "architectExecutor">
  & { readonly architectExecutor: SettingsArchitectExecutorProjection | null };

export interface SettingsAuthoritativeSnapshot {
  readonly config: SettingsRegistryConfig;
  readonly runActive: boolean;
  readonly route: SettingsRouteProjection | null;
  /**
   * FIX-18 (F3): the provider runtime's one runnable-route predicate.
   * `false` means the route cannot run right now — the Models row value
   * then says so instead of contradicting the "No active route" status two
   * rows away. `undefined` (older snapshot sources) claims nothing.
   */
  readonly routeRunnable?: boolean;
  readonly providers: readonly SettingsProviderProjection[];
  readonly approvalRules: readonly SettingsApprovalRuleProjection[];
  readonly costs: SettingsCostProjection;
  readonly cachedModels: readonly ModelInfo[];
  readonly cross: SettingsCrossProjection;
}

const PROVIDER_BACKEND_ORDER = [
  "openrouter",
  "kimi-code",
  "nano-gpt",
  "anthropic",
] as const satisfies readonly ProviderCommandBackendId[];

const PROVIDER_ACTION_ORDER = [
  "connect",
  "enable",
  "disable",
  "disconnect",
  "reconnect",
  "models",
  "logout",
] as const satisfies readonly ProviderBackendAction[];

const COMPRESSION_CHOICES = [
  { value: "off", label: "Off", description: "Never compress context automatically" },
  { value: "auto", label: "Automatic", description: "Compress context when needed" },
  { value: "always", label: "Always", description: "Compress context before every run" },
] as const satisfies readonly SettingsChoice[];

const PROVIDER_SORT_CHOICES = [
  { value: "off", label: "Off", description: "Send no preferred provider sort" },
  { value: "price", label: "Price", description: "Prefer cheaper providers" },
  { value: "throughput", label: "Throughput", description: "Prefer providers with higher throughput" },
  { value: "latency", label: "Latency", description: "Prefer providers with lower latency" },
] as const satisfies readonly SettingsChoice[];

const DATA_COLLECTION_CHOICES = [
  { value: "deny", label: "Deny", description: "Don't allow providers that share data" },
  { value: "allow", label: "Allow", description: "Allow providers that share data" },
] as const satisfies readonly SettingsChoice[];

const ON_OFF_CHOICES = [
  { value: "on", label: "On", description: "Turn the setting on" },
  { value: "off", label: "Off", description: "Turn the setting off" },
] as const satisfies readonly SettingsChoice[];

const APPROVAL_CHOICES = [
  { value: "read-only", label: "Read only", description: "Read only; file changes and shell commands are blocked. Reading credential files still asks first." },
  { value: "ask", label: "Ask", description: "Ask before file changes and every shell command." },
  { value: "auto-edit", label: "Auto-edit", description: "File changes happen automatically; shell commands still ask first. Protected paths still ask regardless." },
  { value: "allow-all", label: "Allow all", description: "File changes and shell commands run without asking. Dangerous. Only protected paths still ask." },
] as const satisfies readonly SettingsChoice[];

const BUDGET_ACTION_CHOICES = [
  { value: "warn", label: "Warn", description: "Warn when exceeded and continue" },
  { value: "block", label: "Block", description: "Block new runs when exceeded" },
] as const satisfies readonly SettingsChoice[];

const VERIFY_MODE_CHOICES = [
  { value: "off", label: "Off", description: "Don't run automatic checks after changes" },
  { value: "on-edit", label: "After changes", description: "Run configured checks after file changes" },
] as const satisfies readonly SettingsChoice[];

const WEB_MODE_CHOICES = [
  { value: "auto", label: "Automatic", description: "Offer web access depending on the task" },
  { value: "on", label: "On", description: "Enable the web tool" },
  { value: "off", label: "Off", description: "Disable the web tool" },
] as const satisfies readonly SettingsChoice[];

const GLYPH_MODE_CHOICES = [
  { value: "auto", label: "Automatic", description: "Account for terminal capabilities automatically" },
  { value: "unicode", label: "Unicode", description: "Force Unicode glyphs" },
  { value: "ascii", label: "ASCII", description: "Use ASCII glyphs only" },
] as const satisfies readonly SettingsChoice[];

const READONLY_EDITOR = Object.freeze({ kind: "readonly" } as const);
const KIMI_EXTERNAL_MODEL_ROLE_UNSUPPORTED =
  "Kimi Code doesn't support this external model role; an OpenRouter route is required";
const NANO_UNSUPPORTED_CONTROL = "Nano-GPT does not support this control; choose the main model manually";
const NANO_UNSUPPORTED_CONTROLS: ReadonlySet<SettingsItemId> = new Set([
  "compressor-model", "reasoning", "reasoning-compressor", "panel-models", "panel-judge",
  "transcription-model", "web-mode", "provider-sort", "provider-fallback",
  "provider-data-collection", "provider-only", "provider-ignore",
]);
const CROSS_ALIASES = ["cross", "lead", "challenger", "review"] as const;
const CROSS_UNAVAILABLE_FALLBACK = "Cross is unavailable";
const CROSS_SWAP_INCOMPLETE = "Both roles must be set before swapping";
const CROSS_REASONING_ROLE_UNSET = "Choose a model first";

interface ItemInput {
  readonly id: SettingsItemId;
  readonly categoryId: SettingsCategoryId;
  readonly label: string;
  readonly description: string;
  readonly aliases?: readonly string[];
  readonly displayValue: string;
  readonly editor: SettingsEditorDescriptor;
  readonly affectsActiveRun: boolean;
  readonly disabledReason?: string;
}

/**
 * Stamps `section` onto a builder's own sub-array (V4-B). Written as a
 * wrapper around the group rather than a field on every `item()` call for
 * one reason: it makes CONTIGUITY structural. A row can only be in a section
 * by being inside that section's bracket, so the heading order is the row
 * order and no row can be quietly filed under a heading that is nowhere near
 * it in the list.
 */
function inSection(section: string, items: readonly SettingsItem[]): SettingsItem[] {
  return items.map((entry) => Object.freeze({ ...entry, section }));
}

export function buildSettingsRegistry(
  snapshot: SettingsAuthoritativeSnapshot,
): SettingsRegistry {
  const categories = SETTINGS_CATEGORY_IDS.map(categoryDefinition);
  const items = [
    ...modelItems(snapshot),
    ...providerItems(snapshot),
    ...securityItems(snapshot),
    ...costItems(snapshot),
    ...toolItems(snapshot),
    ...appearanceItems(snapshot),
  ];
  return Object.freeze({
    categories: Object.freeze(categories),
    items: Object.freeze(items),
  });
}

export function searchSettings(
  registry: SettingsRegistry,
  query: string,
): readonly SettingsItem[] {
  const wanted = normalizeSearchText(query);
  if (!wanted) return registry.items;
  const categoryLabels = new Map<SettingsCategoryId, string>(
    registry.categories.map((category) => [category.id, category.label]),
  );
  return registry.items
    .map((candidate, index) => ({
      candidate,
      index,
      score: searchScore(candidate, wanted, categoryLabels.get(candidate.categoryId)),
    }))
    .filter((entry) => entry.score !== null)
    .sort((left, right) => left.score! - right.score! || left.index - right.index)
    .map(({ candidate }) => candidate);
}

/**
 * FIX-15: the tokens `/settings <category>` accepts. Every canonical id is
 * always valid — the list below only adds the words an owner is likely to
 * reach for instead ("theme" for Appearance, "approvals" for the awkward
 * "approvals-costs"). These same tokens are `/settings`'s own command
 * aliases in the catalog, so `/theme` and `/settings theme` are one
 * mechanism reaching one category, not two entry points.
 */
const SETTINGS_CATEGORY_ALIASES = lookupTable<SettingsCategoryId>({
  model: "models",
  account: "accounts",
  provider: "accounts",
  providers: "accounts",
  approvals: "approvals-costs",
  costs: "approvals-costs",
  tool: "tools",
  theme: "appearance",
  themes: "appearance",
});

/** The Settings category `token` names, or `undefined` when it names none. */
export function resolveSettingsCategory(token: string): SettingsCategoryId | undefined {
  const normalized = token.trim().toLowerCase();
  return SETTINGS_CATEGORY_IDS.find((id) => id === normalized)
    ?? SETTINGS_CATEGORY_ALIASES[normalized];
}

/**
 * The one place a Settings category's owner-facing label is spelled. The
 * palette's own group labels (COMMAND_TREE, command-catalog.ts) reuse these
 * exact strings — FIX-15's one-vocabulary rule — so this accessor exists to
 * be read by anything that must not drift from them.
 */
export function settingsCategoryLabel(id: SettingsCategoryId): string {
  return categoryDefinition(id).label;
}

function categoryDefinition(id: SettingsCategoryId): SettingsCategory {
  switch (id) {
    case "models":
      return Object.freeze({
        id,
        label: "Models",
        description: "Choose your model, tune reasoning, and manage compression to control cost and quality.",
      });
    case "accounts":
      return Object.freeze({
        id,
        label: "Accounts",
        description: "Connect and manage the providers powering your models.",
      });
    case "approvals-costs":
      return Object.freeze({
        id,
        label: "Approvals & Costs",
        description: "Decide what the agent may do without asking, and set spending limits.",
      });
    case "tools":
      return Object.freeze({
        id,
        label: "Tools",
        description: "Turn features like verification, browsing, panels, and voice on or off.",
      });
    case "appearance":
      return Object.freeze({
        id,
        label: "Appearance",
        description: "Customize the logo, header mark, and terminal characters.",
      });
    default:
      return assertNever(id);
  }
}

function modelItems(snapshot: SettingsAuthoritativeSnapshot): SettingsItem[] {
  const config = snapshot.config;
  const swapDisabledReason = crossSwapDisabledReason(snapshot.cross);
  const mainReasoning = reasoningRowProjection(config, snapshot.cachedModels, config.mainModel);
  const compressorReasoning = reasoningRowProjection(config, snapshot.cachedModels, config.compressorModel);
  const leadModelId = snapshot.cross.preferences.lead?.requestedModelId ?? null;
  const challengerModelId = snapshot.cross.preferences.challenger?.requestedModelId ?? null;
  const leadReasoning = reasoningRowProjection(config, snapshot.cachedModels, leadModelId);
  const challengerReasoning = reasoningRowProjection(config, snapshot.cachedModels, challengerModelId);
  const crossUnavailableReason = snapshot.cross.available === false
    ? snapshot.cross.unavailableReason ?? CROSS_UNAVAILABLE_FALLBACK
    : undefined;
  const leadGate = crossUnavailableReason
    ?? (leadModelId === null ? CROSS_REASONING_ROLE_UNSET : leadReasoning.disabledReason);
  const challengerGate = crossUnavailableReason
    ?? (challengerModelId === null ? CROSS_REASONING_ROLE_UNSET : challengerReasoning.disabledReason);
  return [
    ...inSection("Main model", [
      item(snapshot, {
        id: "main-model",
        categoryId: "models",
        label: "Model",
        // F7 (ruling 4): folds the retired "Current route" row's safe,
        // non-fabricated status (provider, and the requested→canonical id
        // when they diverge — "No active route" when nothing is bound yet)
        // into this row's own detail line, F3-composition style, ahead of
        // the static explanation. No information is lost: this is the exact
        // same `routeDisplay` string the removed row's own displayValue used
        // to show.
        description: `${routeDisplay(snapshot.route)} · Atomically switch the provider-bound main model and active session route`,
        // Fix round 1, M2: "provider"/"anbieter" carry over from the retired
        // "current-route" row's own aliases — a "provider" search must still
        // surface the row that now shows route status, not silently lose it.
        aliases: ["modell", "route", "main", "provider", "anbieter"],
        // FIX-18 (F3): the row VALUE reflects the same connection reality the
        // description's route status and /provider status already state — it
        // must not present the configured model as if it were bound while the
        // runtime says nothing can run.
        displayValue: snapshot.routeRunnable === false
          ? `${modelDisplay(snapshot.cachedModels, config.mainModel)} · not connected`
          : modelDisplay(snapshot.cachedModels, config.mainModel),
        editor: { kind: "model", actionId: "main-model", filter: "main" },
        affectsActiveRun: true,
      }),
      item(snapshot, {
        id: "reasoning",
        categoryId: "models",
        label: "Thinking · main model",
        description: "Thinking mode or supported effort level for the main model",
        aliases: ["thinking", "denken", "effort"],
        displayValue: mainReasoning.displayValue,
        editor: { kind: "choice", actionId: "reasoning", options: mainReasoning.options },
        affectsActiveRun: true,
        ...(mainReasoning.disabledReason ? { disabledReason: mainReasoning.disabledReason } : {}),
      }),
    ]),
    ...inSection("Summarizing", [
      item(snapshot, {
        id: "compression-mode",
        categoryId: "models",
        label: "Summarize long chats",
        description: "Controls when a long chat gets shortened by the summarizer model",
        aliases: ["kompression", "context", "compress", "efficiency", "effizienz", "sparen"],
        displayValue: compressionModeLabel(config.compressionMode),
        editor: { kind: "choice", actionId: "compression-mode", options: COMPRESSION_CHOICES },
        affectsActiveRun: true,
      }),
      item(snapshot, {
        id: "compressor-model",
        categoryId: "models",
        label: "Summarizer model",
        description: "Choose the model that shortens a long chat",
        aliases: ["kompressor", "zusammenfassen", "compressor", "efficiency", "effizienz", "sparen"],
        displayValue: modelDisplay(snapshot.cachedModels, config.compressorModel),
        editor: { kind: "model", actionId: "compressor-model", filter: "compressor" },
        affectsActiveRun: true,
        ...(snapshot.route?.backendId === "kimi-code"
          ? { disabledReason: KIMI_EXTERNAL_MODEL_ROLE_UNSUPPORTED }
          : {}),
      }),
      item(snapshot, {
        id: "reasoning-compressor",
        categoryId: "models",
        label: "Thinking · summarizer",
        description: "Thinking mode or supported effort level for the summarizer model",
        aliases: ["thinking", "denken", "effort", "kompressor", "compressor"],
        displayValue: compressorReasoning.displayValue,
        editor: { kind: "choice", actionId: "reasoning-compressor", options: compressorReasoning.options },
        affectsActiveRun: true,
        ...(compressorReasoning.disabledReason ? { disabledReason: compressorReasoning.disabledReason } : {}),
      }),
    ]),
    ...inSection("Cross pair", [
      item(snapshot, {
        id: "cross-lead-model",
        categoryId: "models",
        label: "Cross: coding model",
        // P15 item 1: the pair row itself discloses the role's think level,
        // composed the same F7 way `main-model` folds its route status ahead of
        // its static explanation. The VALUE comes from `leadReasoning` — the
        // exact same `reasoningRowProjection` that feeds the "Thinking · Cross
        // coding" row's own editor two rows above — so the pair row can never
        // disagree with the row that edits it. One mechanism, one store; this
        // row stays a model picker and grows no second editor.
        description: crossRoleDescription(leadModelId, leadReasoning, "Default coding model for Cross — writes files"),
        aliases: [...CROSS_ALIASES],
        displayValue: crossRoleDisplay(snapshot.cachedModels, snapshot.cross.preferences, "lead"),
        editor: { kind: "model", actionId: "cross-lead-model", filter: "cross-lead" },
        affectsActiveRun: false,
        ...(snapshot.cross.available === false
          ? { disabledReason: snapshot.cross.unavailableReason ?? CROSS_UNAVAILABLE_FALLBACK }
          : {}),
      }),
      item(snapshot, {
        id: "cross-challenger-model",
        categoryId: "models",
        label: "Cross: review model",
        /** P15 item 1 — see `cross-lead-model` above for why this value is `challengerReasoning`'s. */
        description: crossRoleDescription(challengerModelId, challengerReasoning, "Default review model for Cross — read-only"),
        aliases: [...CROSS_ALIASES],
        displayValue: crossRoleDisplay(snapshot.cachedModels, snapshot.cross.preferences, "challenger"),
        editor: { kind: "model", actionId: "cross-challenger-model", filter: "cross-challenger" },
        affectsActiveRun: false,
        ...(snapshot.cross.available === false
          ? { disabledReason: snapshot.cross.unavailableReason ?? CROSS_UNAVAILABLE_FALLBACK }
          : {}),
      }),
      item(snapshot, {
        id: "reasoning-cross-lead",
        categoryId: "models",
        label: "Thinking · Cross coding",
        description: "Thinking mode or supported effort level for the Cross coding model",
        aliases: [...CROSS_ALIASES, "thinking", "denken", "effort"],
        displayValue: leadReasoning.displayValue,
        editor: { kind: "choice", actionId: "reasoning-cross-lead", options: leadReasoning.options },
        affectsActiveRun: false,
        ...(leadGate ? { disabledReason: leadGate } : {}),
      }),
      item(snapshot, {
        id: "reasoning-cross-challenger",
        categoryId: "models",
        label: "Thinking · Cross review",
        description: "Thinking mode or supported effort level for the Cross review model",
        aliases: [...CROSS_ALIASES, "thinking", "denken", "effort"],
        displayValue: challengerReasoning.displayValue,
        editor: { kind: "choice", actionId: "reasoning-cross-challenger", options: challengerReasoning.options },
        affectsActiveRun: false,
        ...(challengerGate ? { disabledReason: challengerGate } : {}),
      }),
      item(snapshot, {
        id: "cross-pair-swap",
        categoryId: "models",
        label: "Swap Cross pair",
        description: "Exchange the coding and review roles",
        aliases: [...CROSS_ALIASES, "swap"],
        displayValue: "Swap",
        editor: { kind: "invoke", actionId: "cross-pair-swap" },
        affectsActiveRun: false,
        ...(swapDisabledReason ? { disabledReason: swapDisabledReason } : {}),
      }),
    ]),
    ...inSection("Architect", [
      // Phase 14 (ruling 2): beside the Cross pair rows above — same
      // external-action pattern (editor `kind: "model"`), same picker
      // machinery (`ModelRoutePickerPort`, wired the same way `main-model`/
      // `compressor-model`/the Cross pair already are in tui.ts's `edit()`),
      // same provider-aware filtering. Unlike Cross's pair, this is a single
      // route with no counterpart to stage against — it commits immediately.
      item(snapshot, {
        id: "architect-executor-model",
        categoryId: "models",
        label: "Architect: executor model",
        description: "Cheaper model /architect uses to implement an accepted plan",
        aliases: ["architect", "executor", "planner"],
        displayValue: architectExecutorDisplay(snapshot.cachedModels, config.architectExecutor),
        editor: { kind: "model", actionId: "architect-executor-model", filter: "architect-executor" },
        affectsActiveRun: false,
        // The one shared predicate `/architect` itself gates on
        // (`architectUnavailableReasonForRoute`, architect.ts) — never a
        // second inline `=== "kimi-code"` that could drift from it.
        ...(architectUnavailableReasonForRoute(snapshot.route)
          ? { disabledReason: architectUnavailableReasonForRoute(snapshot.route)! }
          : {}),
      }),
    ]),
  ];
}

function providerItems(snapshot: SettingsAuthoritativeSnapshot): SettingsItem[] {
  const result: SettingsItem[] = [
    item(snapshot, {
      id: "provider-setup",
      categoryId: "accounts",
      label: "Set up a provider",
      description: "Open the guided setup for supported providers",
      aliases: ["setup", "verbinden", "konto"],
      displayValue: "Open",
      editor: { kind: "invoke", actionId: "provider-setup" },
      affectsActiveRun: true,
    }),
  ];
  for (const provider of orderedProviders(snapshot.providers)) {
    result.push(item(snapshot, {
      id: `provider-status:${provider.backendId}`,
      categoryId: "accounts",
      label: provider.displayName,
      description: "What this account is connected to, and whether it's working",
      aliases: providerAliases(provider.backendId),
      displayValue: providerStatusDisplay(provider),
      editor: READONLY_EDITOR,
      affectsActiveRun: false,
    }));
    if (provider.backendId === "anthropic"
      || provider.availability === "coming-soon"
      || provider.maturity === "coming-soon") continue;
    const allowed = new Set(provider.allowedActions);
    for (const action of PROVIDER_ACTION_ORDER) {
      if (!allowed.has(action)) continue;
      const definition = providerActionDefinition(action);
      result.push(item(snapshot, {
        id: `provider-action:${provider.backendId}:${action}`,
        categoryId: "accounts",
        label: `${provider.displayName}: ${definition.label}`,
        description: `${definition.description} (${provider.displayName})`,
        aliases: [provider.backendId, action, definition.label],
        displayValue: "Run",
        editor: { kind: "invoke", actionId: definition.actionId },
        affectsActiveRun: true,
      }));
    }
  }
  return [
    // Accounts' two natural groups: the accounts themselves (setup plus each
    // provider's status and its own lifecycle actions), and the routing
    // preferences that apply across them. `privacyItems` is spliced through
    // here but belongs to Approvals & Costs, so it carries that category's
    // own section rather than either of these.
    ...inSection("Providers", result),
    ...inSection("OpenRouter routing", [
      item(snapshot, {
        id: "provider-sort",
        categoryId: "accounts",
        label: "OpenRouter provider sort",
        description: "Prefer providers by price, throughput, or latency",
        aliases: ["sort", "preis", "latenz", "durchsatz"],
        displayValue: providerSortLabel(snapshot.config.provider.sort),
        editor: { kind: "choice", actionId: "provider-sort", options: PROVIDER_SORT_CHOICES },
        affectsActiveRun: true,
      }),
    ]),
    ...privacyItems(snapshot),
    ...inSection("OpenRouter routing", [
      item(snapshot, {
        id: "provider-fallback",
        categoryId: "accounts",
        label: "OpenRouter provider fallback",
        description: "Let OpenRouter use a backup provider for the same model",
        aliases: ["provider fallback", "backup provider"],
        displayValue: optionalBooleanLabel(snapshot.config.provider.allowFallbacks),
        editor: { kind: "choice", actionId: "provider-fallback", options: ON_OFF_CHOICES },
        affectsActiveRun: true,
      }),
    ]),
  ];
}

function securityItems(snapshot: SettingsAuthoritativeSnapshot): SettingsItem[] {
  const rules = orderedRules(snapshot.approvalRules);
  const result: SettingsItem[] = [
    item(snapshot, {
      id: "approval-mode",
      categoryId: "approvals-costs",
      label: "Approval mode",
      description: "Sets which tool actions require explicit confirmation",
      aliases: ["approval", "berechtigung", "sicherheit"],
      displayValue: approvalModeLabel(snapshot.config.approvalMode),
      editor: { kind: "choice", actionId: "approval-mode", options: APPROVAL_CHOICES },
      affectsActiveRun: true,
    }),
  ];
  for (const rule of rules) {
    const anchor = ruleAnchor(rule.id);
    result.push(
      item(snapshot, {
        id: `approval-rule:${rule.id}`,
        categoryId: "approvals-costs",
        label: `Remembered rule · ${anchor}`,
        description: "Read-only view of a locally remembered tool approval",
        aliases: ["regel", "remembered", anchor],
        displayValue: `${rule.decision === "allow" ? "Allow" : "Deny"} · Rule ${anchor}`,
        editor: READONLY_EDITOR,
        affectsActiveRun: false,
      }),
      item(snapshot, {
        id: `approval-forget:${rule.id}`,
        categoryId: "approvals-costs",
        label: `Forget rule · ${anchor}`,
        description: "Remove this remembered tool approval after confirmation",
        aliases: ["regel löschen", "forget", anchor],
        displayValue: `Rule ${anchor}`,
        editor: { kind: "confirm", actionId: "approval-forget", destructive: true },
        affectsActiveRun: true,
      }),
    );
  }
  result.push(
    item(snapshot, {
      id: "approval-forget-all",
      categoryId: "approvals-costs",
      label: "Forget all rules",
      description: "Remove all remembered tool approvals for this folder after confirmation",
      aliases: ["regeln löschen", "forget all"],
      displayValue: pluralize(rules.length, "rule"),
      editor: { kind: "confirm", actionId: "approval-forget-all", destructive: true },
      affectsActiveRun: true,
      ...(rules.length === 0 ? { disabledReason: "No remembered rules" } : {}),
    }),
  );
  return inSection("Approvals", result);
}

function privacyItems(snapshot: SettingsAuthoritativeSnapshot): SettingsItem[] {
  const provider = snapshot.config.provider;
  return inSection("Privacy", [
    item(snapshot, {
      id: "provider-data-collection",
      categoryId: "approvals-costs",
      label: "OpenRouter data sharing",
      description: "Sets whether OpenRouter may use providers that share data",
      aliases: ["datenschutz", "privacy", "data collection"],
      displayValue: provider.dataCollection === "allow" ? "Allow" : "Deny",
      editor: { kind: "choice", actionId: "provider-data-collection", options: DATA_COLLECTION_CHOICES },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "provider-only",
      categoryId: "approvals-costs",
      label: "Only these OpenRouter providers",
      description: "Limit execution to an explicitly allowed provider list",
      aliases: ["allowlist", "only", "provider liste"],
      displayValue: stringListLabel(provider.only),
      editor: { kind: "text", actionId: "provider-only", valueKind: "provider-list" },
      affectsActiveRun: true,
    }),
    item(snapshot, {
      id: "provider-ignore",
      categoryId: "approvals-costs",
      label: "Ignore these OpenRouter providers",
      description: "Skip explicitly excluded providers during selection",
      aliases: ["denylist", "ignore", "provider ausschließen"],
      displayValue: stringListLabel(provider.ignore),
      editor: { kind: "text", actionId: "provider-ignore", valueKind: "provider-list" },
      affectsActiveRun: true,
    }),
  ]);
}

function costItems(snapshot: SettingsAuthoritativeSnapshot): SettingsItem[] {
  const config = snapshot.config;
  return [
    ...inSection("Costs & budgets", [
      item(snapshot, {
        id: "max-cost",
        categoryId: "approvals-costs",
        label: "Cost limit per main run",
        description: "Maximum estimated main-model cost of a run, in USD",
        aliases: ["kosten", "max cost", "lauf limit"],
        displayValue: formatUsd(config.maxCostUsd),
        editor: { kind: "number", actionId: "max-cost", minimum: 0.001, maximum: 1_000, unit: "USD" },
        affectsActiveRun: true,
      }),
      // FIX-15 (command-IA, ratified): these three rows are limits on what a
      // run may spend or do. "Actions per run" sat in Tools, where it read as
      // a feature switch rather than the guard rail it is; the summarizer cost
      // cap and the low-balance warning sat in Models, beside the model
      // pickers they merely constrain. All three belong beside the cost limit
      // and the budget an owner reasons about them with.
      item(snapshot, {
        id: "max-steps",
        categoryId: "approvals-costs",
        label: "Actions per run",
        description: "How many actions the model may take in a single run",
        aliases: ["schritte", "steps", "werkzeuge"],
        displayValue: String(config.maxSteps),
        editor: { kind: "number", actionId: "max-steps", minimum: 1, maximum: 100 },
        affectsActiveRun: true,
      }),
      item(snapshot, {
        id: "compressor-max-cost",
        categoryId: "approvals-costs",
        label: "Summarizer cost cap",
        description: "Maximum estimated summarizer model cost in USD",
        aliases: ["kompressor kosten", "compressor limit", "efficiency", "effizienz", "sparen"],
        displayValue: formatUsd(config.compressorMaxCostUsd),
        editor: { kind: "number", actionId: "compressor-max-cost", minimum: 0.001, maximum: 100, unit: "USD" },
        affectsActiveRun: true,
      }),
      item(snapshot, {
        id: "budget-daily",
        categoryId: "approvals-costs",
        label: "Daily budget",
        description: "Folder cost limit per day, or off",
        aliases: ["budget", "tag", "daily"],
        displayValue: optionalUsd(config.budget.dailyLimitUsd),
        editor: { kind: "number", actionId: "budget-daily", minimum: 0.01, maximum: 100_000, allowOff: true, unit: "USD" },
        affectsActiveRun: true,
      }),
      item(snapshot, {
        id: "budget-total",
        categoryId: "approvals-costs",
        label: "Total budget",
        description: "Cumulative folder cost limit, or off",
        aliases: ["gesamtbudget", "total budget"],
        displayValue: optionalUsd(config.budget.totalLimitUsd),
        editor: { kind: "number", actionId: "budget-total", minimum: 0.01, maximum: 100_000, allowOff: true, unit: "USD" },
        affectsActiveRun: true,
      }),
      item(snapshot, {
        id: "budget-on-exceed",
        categoryId: "approvals-costs",
        label: "When over budget",
        description: "Warn or block new runs after going over",
        aliases: ["budget aktion", "warn", "block"],
        displayValue: config.budget.onExceed === "block" ? "Block" : "Warn",
        editor: { kind: "choice", actionId: "budget-on-exceed", options: BUDGET_ACTION_CHOICES },
        affectsActiveRun: true,
      }),
      item(snapshot, {
        id: "low-balance-threshold",
        categoryId: "approvals-costs",
        label: "Low-balance warning",
        description: "Warn when your remaining provider credit drops below this amount, or 0 to disable",
        aliases: ["low balance", "balance warnung", "kontostand warnung", "warnschwelle", "efficiency", "effizienz", "sparen"],
        displayValue: config.lowBalanceThresholdUsd > 0
          ? formatUsd(config.lowBalanceThresholdUsd)
          : "Off",
        editor: { kind: "number", actionId: "low-balance-threshold", minimum: 0, maximum: 1_000, unit: "USD" },
        // D6: visibility only — nothing in a running agent ever reads this
        // threshold (unlike max-cost/budget-daily, which an active run's own
        // guard actively checks), so there is nothing an in-flight edit could
        // destabilize.
        affectsActiveRun: false,
      }),
      item(snapshot, {
        id: "cost-summary",
        categoryId: "approvals-costs",
        label: "Current cost",
        description: "Read-only cost for this chat, today, and this folder",
        aliases: ["kostenstand", "verbrauch", "spend"],
        displayValue: costSummary(snapshot.costs),
        editor: READONLY_EDITOR,
        affectsActiveRun: false,
      }),
    ]),
  ];
}

function toolItems(snapshot: SettingsAuthoritativeSnapshot): SettingsItem[] {
  const config = snapshot.config;
  return [
    ...inSection("Verification", [
      item(snapshot, {
        id: "verify-mode",
        categoryId: "tools",
        label: "Verify mode",
        description: "Turn automatic checks after file changes on or off",
        aliases: ["prüfen", "verify", "check"],
        displayValue: config.verify.mode === "on-edit" ? "After changes" : "Off",
        editor: { kind: "choice", actionId: "verify-mode", options: VERIFY_MODE_CHOICES },
        affectsActiveRun: true,
      }),
      item(snapshot, {
        id: "verify-commands",
        categoryId: "tools",
        label: "Verify commands",
        description: "Edit the ordered local commands used for automatic verification",
        aliases: ["commands", "tests", "build"],
        displayValue: config.verify.commands.length > 0 ? config.verify.commands.join(" · ") : "None",
        editor: { kind: "text", actionId: "verify-commands", valueKind: "command-list" },
        affectsActiveRun: true,
      }),
      item(snapshot, {
        id: "verify-suggest",
        categoryId: "tools",
        label: "Suggest verify commands",
        description: "Derive suitable commands from this folder's existing project scripts",
        aliases: ["suggest", "package scripts", "empfehlen"],
        displayValue: "Run",
        editor: { kind: "invoke", actionId: "verify-suggest" },
        affectsActiveRun: true,
      }),
      item(snapshot, {
        id: "verify-clear",
        categoryId: "tools",
        label: "Clear verify commands",
        description: "Remove all configured verify commands after confirmation",
        aliases: ["clear", "tests löschen"],
        displayValue: pluralize(config.verify.commands.length, "command"),
        editor: { kind: "confirm", actionId: "verify-clear", destructive: true },
        affectsActiveRun: true,
        ...(config.verify.commands.length === 0 ? { disabledReason: "No verify commands" } : {}),
      }),
      item(snapshot, {
        id: "verify-repair-rounds",
        categoryId: "tools",
        label: "Retries after a failed check",
        description: "How many times the model may try again after a check fails",
        aliases: ["repair", "runden", "retry"],
        displayValue: String(config.verify.maxRepairRounds),
        editor: { kind: "number", actionId: "verify-repair-rounds", minimum: 0, maximum: 2 },
        affectsActiveRun: true,
      }),
    ]),
    ...inSection("Web & browser", [
      item(snapshot, {
        id: "web-mode",
        categoryId: "tools",
        label: "Web mode",
        description: "Control availability of the web tool for agent runs",
        aliases: ["web", "internet", "browse"],
        displayValue: webModeLabel(config.web),
        editor: { kind: "choice", actionId: "web-mode", options: WEB_MODE_CHOICES },
        affectsActiveRun: true,
      }),
      item(snapshot, {
        id: "browser-path",
        categoryId: "tools",
        label: "Browser path",
        description: "Set an explicit path to Chrome, Chromium, Edge, or Brave",
        aliases: ["browser", "chrome", "executable", "pfad"],
        displayValue: config.browserPath || "Search automatically",
        editor: { kind: "text", actionId: "browser-path", valueKind: "path" },
        affectsActiveRun: true,
      }),
      item(snapshot, {
        id: "browser-timeout",
        categoryId: "tools",
        label: "Browser timeout",
        description: "Cancel browser startup and page checks after a fixed duration",
        aliases: ["browser timeout", "zeitlimit", "start"],
        displayValue: `${config.browserTimeoutSeconds} s`,
        editor: { kind: "number", actionId: "browser-timeout", minimum: 1, maximum: 120, unit: "s" },
        affectsActiveRun: true,
      }),
    ]),
    ...inSection("Panel", [
      item(snapshot, {
        id: "panel-models",
        categoryId: "tools",
        label: "Panel models",
        description: "Choose two to five models for parallel response comparisons",
        aliases: ["panel", "vergleich", "mehrere modelle"],
        displayValue: config.panelModels.length > 0
          ? config.panelModels.map((id) => modelDisplay(snapshot.cachedModels, id)).join(" · ")
          : "Not set",
        editor: { kind: "model", actionId: "panel-models", filter: "panel", multiple: true },
        affectsActiveRun: true,
        ...(snapshot.route?.backendId === "kimi-code"
          ? { disabledReason: KIMI_EXTERNAL_MODEL_ROLE_UNSUPPORTED }
          : {}),
      }),
      item(snapshot, {
        id: "panel-judge",
        categoryId: "tools",
        label: "Panel judge",
        description: "Synthesize the panel's answers — costs one extra model call on the main model per /panel run",
        aliases: ["judge", "richter", "synthese"],
        displayValue: booleanLabel(config.panelJudge),
        editor: { kind: "choice", actionId: "panel-judge", options: ON_OFF_CHOICES },
        affectsActiveRun: true,
      }),
    ]),
    ...inSection("Voice", [
      item(snapshot, {
        id: "transcription-model",
        categoryId: "tools",
        label: "Transcription model",
        description: "Choose an audio-input-capable model for voice recordings",
        aliases: ["voice", "audio", "whisper", "transkription"],
        displayValue: modelDisplay(snapshot.cachedModels, config.transcriptionModel),
        editor: { kind: "model", actionId: "transcription-model", filter: "audio-input" },
        affectsActiveRun: true,
        ...(snapshot.route?.backendId === "kimi-code"
          ? { disabledReason: KIMI_EXTERNAL_MODEL_ROLE_UNSUPPORTED }
          : {}),
      }),
      item(snapshot, {
        id: "voice-consent-status",
        categoryId: "tools",
        label: "Voice consent",
        description: "Read-only status of explicit consent to upload recordings",
        aliases: ["voice consent", "microphone", "mikrofon", "aufnahme"],
        displayValue: config.voiceConsentGiven ? "Granted" : "Not granted",
        editor: READONLY_EDITOR,
        affectsActiveRun: false,
      }),
      item(snapshot, {
        id: "voice-consent-clear",
        categoryId: "tools",
        label: "Reset voice consent",
        description: "Remove stored voice consent after confirmation; a new consent only happens in the voice flow",
        aliases: ["voice consent clear", "microphone", "mikrofon zurücksetzen"],
        displayValue: config.voiceConsentGiven ? "Reset" : "Not granted",
        editor: { kind: "confirm", actionId: "voice-consent-clear", destructive: true },
        affectsActiveRun: true,
        ...(!config.voiceConsentGiven ? { disabledReason: "No voice consent stored" } : {}),
      }),
    ]),
  ];
}

function appearanceItems(snapshot: SettingsAuthoritativeSnapshot): SettingsItem[] {
  const appearance = snapshot.config.appearance;
  return [
    item(snapshot, {
      id: "appearance-large-logo",
      categoryId: "appearance",
      label: "Large ORCODE logo",
      description: "Show the large ORCODE mark on the welcome screen and in Settings",
      aliases: ["logo", "route core", "start"],
      displayValue: booleanLabel(appearance.showLargeLogo),
      editor: { kind: "choice", actionId: "appearance-large-logo", options: ON_OFF_CHOICES },
      affectsActiveRun: false,
    }),
    item(snapshot, {
      id: "appearance-header-mark",
      categoryId: "appearance",
      label: "Compact header mark",
      description: "Show the compact ORCODE mark in the normal chat header",
      aliases: ["header", "marke", "compact"],
      displayValue: booleanLabel(appearance.showHeaderMark),
      editor: { kind: "choice", actionId: "appearance-header-mark", options: ON_OFF_CHOICES },
      affectsActiveRun: false,
    }),
    item(snapshot, {
      id: "appearance-glyph-mode",
      categoryId: "appearance",
      label: "Terminal characters",
      description: "Pick the box and arrow characters automatically, or force Unicode or plain ASCII",
      aliases: ["ascii", "unicode", "glyph", "zeichen"],
      displayValue: appearance.glyphMode === "ascii"
        ? "ASCII"
        : appearance.glyphMode === "unicode"
          ? "Unicode"
          : "Automatic",
      editor: { kind: "choice", actionId: "appearance-glyph-mode", options: GLYPH_MODE_CHOICES },
      affectsActiveRun: false,
    }),
  ];
}

function item(snapshot: SettingsAuthoritativeSnapshot, input: ItemInput): SettingsItem {
  const editor = freezeEditor(input.editor);
  const disabledReason = snapshot.runActive
    && input.affectsActiveRun
    && editor.kind !== "readonly"
    ? "Run active"
    : snapshot.route?.backendId === "nano-gpt" && NANO_UNSUPPORTED_CONTROLS.has(input.id)
      ? NANO_UNSUPPORTED_CONTROL
      : input.disabledReason;
  return Object.freeze({
    id: input.id,
    categoryId: input.categoryId,
    label: input.label,
    description: input.description,
    aliases: Object.freeze([...(input.aliases ?? [])]),
    displayValue: input.displayValue,
    editor,
    affectsActiveRun: input.affectsActiveRun,
    ...(disabledReason ? { disabledReason } : {}),
  });
}

function freezeEditor(editor: SettingsEditorDescriptor): SettingsEditorDescriptor {
  switch (editor.kind) {
    case "choice":
      return Object.freeze({
        ...editor,
        options: Object.freeze(editor.options.map((option) => Object.freeze({ ...option }))),
      });
    case "model":
    case "number":
    case "text":
    case "confirm":
    case "invoke":
    case "readonly":
      return Object.freeze({ ...editor });
    default:
      return assertNever(editor);
  }
}

function providerActionDefinition(action: ProviderBackendAction): {
  readonly actionId: SettingsActionId;
  readonly label: string;
  readonly description: string;
} {
  switch (action) {
    case "connect":
      return { actionId: "provider-connect", label: "Connect", description: "Connect the provider through the guided setup" };
    case "enable":
      return { actionId: "provider-enable", label: "Enable", description: "Enable the existing provider connection" };
    case "disable":
      return { actionId: "provider-disable", label: "Disable", description: "Disable the provider connection, subject to its existing confirmation step" };
    case "disconnect":
      return { actionId: "provider-disconnect", label: "Disconnect", description: "Disconnect the provider, subject to its existing confirmation step" };
    case "reconnect":
      return { actionId: "provider-reconnect", label: "Reconnect", description: "Recheck provider status and reconnect" };
    case "models":
      return { actionId: "provider-models", label: "Refresh models", description: "Refresh this provider's available model catalog" };
    case "logout":
      return { actionId: "provider-logout", label: "Log out", description: "Remove the local provider login, subject to its existing confirmation step" };
    default:
      return assertNever(action);
  }
}

function orderedProviders(
  providers: readonly SettingsProviderProjection[],
): SettingsProviderProjection[] {
  const byBackend = new Map<ProviderCommandBackendId, SettingsProviderProjection>();
  for (const provider of providers) {
    if (byBackend.has(provider.backendId)) {
      throw new Error("Settings provider projection is invalid.");
    }
    byBackend.set(provider.backendId, provider);
  }
  return PROVIDER_BACKEND_ORDER
    .map((backendId) => byBackend.get(backendId))
    .filter((provider): provider is SettingsProviderProjection => provider !== undefined);
}

function orderedRules(
  rules: readonly SettingsApprovalRuleProjection[],
): SettingsApprovalRuleProjection[] {
  const byId = new Map<string, SettingsApprovalRuleProjection>();
  for (const rule of rules) {
    if (!CANONICAL_RULE_ID.test(rule.id)
      || (rule.decision !== "allow" && rule.decision !== "deny")
      || byId.has(rule.id)) {
      throw new Error("Settings rule projection is invalid.");
    }
    byId.set(rule.id, { id: rule.id, decision: rule.decision });
  }
  return [...byId.values()].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
}

const CANONICAL_RULE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function ruleAnchor(id: string): string {
  return id.slice(0, 8);
}

function findModel(models: readonly ModelInfo[], id: string): ModelInfo | null {
  return models.find((model) => model.id === id || model.canonicalSlug === id) ?? null;
}

function modelDisplay(models: readonly ModelInfo[], id: string): string {
  const model = findModel(models, id);
  return model && model.name !== id ? `${model.name} · ${id}` : id;
}

interface ReasoningRowProjection {
  readonly displayValue: string;
  readonly options: readonly SettingsChoice[];
  readonly disabledReason?: string;
}

/**
 * Resolves one model ROLE's thinking row. `modelId` is that role's own model
 * id (main/compressor's own field, or a Cross role's `requestedModelId`) —
 * never the main model's id substituted in for another role. Roles key
 * `reasoningByModel` by their own model id, so a role without an entry falls
 * back to the same `DEFAULT_REASONING_SETTING` every other unset model does;
 * there is no inheritance from main. `modelId === null` means the role has no
 * model chosen yet (only possible for the Cross roles); the caller layers the
 * concrete "choose a model" gating for that case, since main/compressor's
 * model id can never be empty.
 */
function reasoningRowProjection(
  // Only `reasoningByModel`/`mainModel` are read, via `getReasoningSetting` —
  // the narrower type is what `SettingsRegistryConfig` satisfies.
  config: OrcodeConfig,
  models: readonly ModelInfo[],
  modelId: string | null,
): ReasoningRowProjection {
  const current = modelId ? getReasoningSetting(config, modelId) : DEFAULT_REASONING_SETTING;
  const label = reasoningLabel(current);
  const resolvedModel = modelId ? findModel(models, modelId) : null;
  if (resolvedModel === null) {
    return {
      displayValue: label,
      options: [{
        value: reasoningChoiceValue(current),
        label: `Saved · ${label}`,
        description: "Saved value; model capabilities can't be checked without current model data",
      }],
      // A role with no model at all has nothing to look up in the catalog;
      // that case is not a catalog miss and gets its own gating upstream.
      ...(modelId ? { disabledReason: "Model catalog not available" } : {}),
    };
  }
  return {
    displayValue: label,
    options: reasoningChoices(resolvedModel, current).map(({ value, label: optionLabel, description }) => ({
      value,
      label: optionLabel,
      description,
    })),
    ...(supportsReasoning(resolvedModel) ? {} : { disabledReason: "Model doesn't support reasoning" }),
  };
}

/**
 * P15 fix round 1 (L3): a Cross pair row's description discloses that role's
 * think level — but ONLY when the role actually has a model.
 *
 * `reasoningRowProjection(config, models, null)` answers `"auto"` for an
 * unset role (its own default), which made the row read
 * `Thinking auto · Default coding model …` while its `displayValue` right
 * beside it said `Not set`: one row, naming a think level for a model that
 * does not exist. The gate deliberately refuses to do this — an unset role
 * there is exactly `CROSS_GATE_NOT_SET`, no level — so the two surfaces
 * disagreed about the same fact at the same moment. They no longer do:
 * no model, no level, on either surface.
 */
function crossRoleDescription(
  modelId: string | null,
  reasoning: ReasoningRowProjection,
  explanation: string,
): string {
  return modelId === null ? explanation : `Thinking ${reasoning.displayValue} · ${explanation}`;
}

/**
 * A genuinely persisted pair can never carry exactly one role (publish
 * rejects partial pairs by design), so "this role set, counterpart not" is
 * an unambiguous signal that the value is staged, not yet saved.
 */
function crossRoleDisplay(
  models: readonly ModelInfo[],
  preferences: SettingsCrossPreferencesProjection,
  role: "lead" | "challenger",
): string {
  const route = preferences[role];
  if (!route) return "Not set";
  const counterpart = role === "lead" ? preferences.challenger : preferences.lead;
  const display = modelDisplay(models, route.requestedModelId);
  return counterpart ? display : `${display} · staged`;
}

/**
 * Phase 14: the executor row's own display, mirroring `crossRoleDisplay`
 * above but for a single, non-paired route — no "staged" state exists here
 * (unlike Cross's pair, one route commits immediately, nothing to wait on).
 */
function architectExecutorDisplay(
  models: readonly ModelInfo[],
  route: SettingsArchitectExecutorProjection | null,
): string {
  return route ? modelDisplay(models, route.requestedModelId) : "Not set";
}

function crossSwapDisabledReason(cross: SettingsCrossProjection): string | undefined {
  if (cross.available === false) return cross.unavailableReason ?? CROSS_UNAVAILABLE_FALLBACK;
  return cross.preferences.lead && cross.preferences.challenger ? undefined : CROSS_SWAP_INCOMPLETE;
}

function routeDisplay(route: SettingsRouteProjection | null): string {
  if (!route) return "No active route";
  const resolved = route.requestedModelId === route.canonicalModelId
    ? route.requestedModelId
    : `${route.requestedModelId} → ${route.canonicalModelId}`;
  return `${route.modelLabel} · ${route.providerLabel} · ${resolved}`;
}

function providerStatusDisplay(provider: SettingsProviderProjection): string {
  // FIX-12: was "Coming soon". The three-way guard below stays exactly as
  // it was (a malformed upstream projection must still not turn this row
  // into a runnable one) — only the promise it printed is gone: no direct
  // Anthropic backend is planned, and `BackendRegistry` forbids it one.
  if (provider.backendId === "anthropic"
    || provider.availability === "coming-soon"
    || provider.maturity === "coming-soon") return ANTHROPIC_DIRECT_BACKEND_NOTICE;
  // FIX-10 fix round 1 (F1): "Disabled" only for a stored connection the
  // user turned off; a backend without any stored connection reads
  // "Not connected" — never a stored-state claim it cannot back.
  const configuration = provider.configuration === "enabled"
    ? "Enabled"
    : provider.configuration === "disabled" ? "Disabled" : "Not connected";
  const maturity = provider.maturity === "stable" ? "Stable" : "Preview";
  const defaultLabel = provider.isDefault ? " · Default route" : "";
  const selected = provider.selectedModel ? ` · ${provider.selectedModel.displayName}` : "";
  return `${configuration} · ${maturity} · ${billingRealmLabel(provider.billingRealm)} · ${headlineLabel(provider.headline)}${defaultLabel}${selected}`;
}

export function billingRealmLabel(billingRealm: SettingsProviderProjection["billingRealm"]): string {
  switch (billingRealm) {
    case "openrouter-payg":
      return "API Pay-as-you-go";
    case "kimi-code-membership-provider-managed-overage":
      return "Subscription · provider-managed";
    case "nanogpt-subscription":
      return "Nano-GPT Abo · kein Guthaben-Fallback";
    case "nanogpt-payg":
      return "Nano-GPT Guthaben · Pay-as-you-go";
    case "none":
      return "No billing";
    default:
      return assertNever(billingRealm);
  }
}

/**
 * The `/provider status` bullet format's `⎿ ✓ <facts>` line (F4, V3 audit
 * principle 4): each `ProviderHealth` field gets a plain-sentence fragment
 * instead of the raw `field=value` chain it used to print. Inputs come from
 * `ProviderCommandStatusEntry.health` (`commands.ts`), which is typed as
 * plain `string` rather than the narrower `ProviderHealth` literal union —
 * so these stay total over arbitrary input (an unrecognized value still
 * reads as an honest, readable fragment) instead of using `assertNever`.
 * All three read lower-case, mid-sentence, so joining them and capitalizing
 * only the first character reproduces the mockup's flowing clause exactly
 * ("Key stored · connection ok · credit available").
 */
export function providerCredentialFactLabel(credential: string): string {
  switch (credential) {
    case "valid":
      return "key stored";
    case "rejected":
      return "key rejected";
    case "expired":
      return "key expired";
    case "login-required":
      return "no key stored";
    case "not-applicable":
      return "no key needed";
    case "unknown":
      return "key not checked";
    default:
      return "key status unknown";
  }
}

export function providerConnectivityFactLabel(connectivity: string): string {
  switch (connectivity) {
    case "connected":
      return "connection ok";
    case "offline":
      return "connection failed";
    case "unknown":
      return "connection not checked";
    default:
      return "connection status unknown";
  }
}

export function providerSpendFactLabel(spend: string): string {
  switch (spend) {
    case "available":
      return "credit available";
    case "limit-reached":
      return "provider limit reached";
    case "unknown":
      return "credit unknown";
    default:
      return "credit status unknown";
  }
}

/**
 * The bullet format's `⎿ ✗ <plain fact>` line: one concrete reason, chosen
 * with the exact same field precedence `deriveProviderHeadline`
 * (`backends.ts`) uses to decide a provider is unhealthy in the first place
 * — credential, then connectivity, then runtime, then spend — just
 * returning the matching plain fragment instead of a `ProviderHeadline` tag.
 * Never called for a healthy provider; the fallback only covers a health
 * snapshot that failed to resolve to `"ready"` for a reason none of these
 * fields explain on their own (e.g. credential/connectivity both merely
 * "unknown") — "not checked" mirrors `headlineLabel`'s own fallback below.
 */
export function providerHealthFailureFactLabel(health: {
  readonly credential: string;
  readonly connectivity: string;
  readonly spend: string;
  readonly runtime: string;
}): string {
  if (health.credential === "login-required") return "no key stored";
  if (health.credential === "rejected") return "key rejected";
  if (health.credential === "expired") return "key expired";
  if (health.connectivity === "offline") return "connection failed";
  if (health.runtime === "missing") return "runtime missing";
  if (health.runtime === "incompatible") return "runtime incompatible";
  if (health.runtime === "policy-unavailable") return "policy unavailable";
  if (health.spend === "limit-reached") return "provider limit reached";
  return "not checked";
}

function headlineLabel(headline: SettingsProviderHeadline | null): string {
  switch (headline) {
    case "ready":
      return "Ready";
    case "login-required":
      return "Login required";
    case "auth-rejected":
      return "Login rejected";
    case "credential-expired":
      return "Login expired";
    case "offline":
      return "Offline";
    case "limit-reached":
      return "Provider limit reached";
    case "runtime-missing":
      return "Runtime missing";
    case "incompatible-runtime":
      return "Runtime incompatible";
    case "policy-unavailable":
      return "Policy unavailable";
    case "unknown":
    case null:
      return "Not checked";
    default:
      return assertNever(headline);
  }
}

function providerAliases(backendId: ProviderCommandBackendId): readonly string[] {
  switch (backendId) {
    case "openrouter":
      return ["openrouter", "api", "payg"];
    case "kimi-code":
      return ["kimi", "kimi code", "abo", "membership"];
    case "nano-gpt":
      return ["nano", "nano-gpt", "nanogpt", "abo", "guthaben", "payg"];
    case "anthropic":
      return ["anthropic", "claude"];
    default:
      return assertNever(backendId);
  }
}

function providerSortLabel(value: OrcodeConfigWithBudget["provider"]["sort"]): string {
  switch (value) {
    case "price":
      return "Price";
    case "throughput":
      return "Throughput";
    case "latency":
      return "Latency";
    case undefined:
      return "Off";
    default:
      return assertNever(value);
  }
}

export function compressionModeLabel(value: OrcodeConfigWithBudget["compressionMode"]): string {
  switch (value) {
    case "off":
      return "Off";
    case "auto":
      return "Automatic";
    case "always":
      return "Always";
    default:
      return assertNever(value);
  }
}

function approvalModeLabel(value: OrcodeConfigWithBudget["approvalMode"]): string {
  switch (value) {
    case "read-only":
      return "Read only";
    case "ask":
      return "Ask";
    case "auto-edit":
      return "Auto-edit";
    case "allow-all":
      return "Allow all";
    default:
      return assertNever(value);
  }
}

function webModeLabel(value: OrcodeConfigWithBudget["web"]): string {
  switch (value) {
    case "on":
      return "On";
    case "off":
      return "Off";
    case "auto":
      return "Automatic";
    default:
      return assertNever(value);
  }
}

function booleanLabel(value: boolean): string {
  return value ? "On" : "Off";
}

function optionalBooleanLabel(value: boolean | undefined): string {
  return value === undefined ? "Automatic" : booleanLabel(value);
}

function optionalUsd(value: number | null): string {
  return value === null ? "Off" : formatUsd(value);
}

function stringListLabel(values: readonly string[] | undefined): string {
  return values && values.length > 0 ? values.join(", ") : "No restriction";
}

function costSummary(costs: SettingsCostProjection): string {
  if (costs.costKnowledge === "unknown") {
    return "cost unknown · provider-managed";
  }
  return `Chat ${formatUsd(costs.sessionUsd)} · Day ${formatUsd(costs.dayUsd)} · Total ${formatUsd(costs.totalUsd)}`;
}

function searchScore(
  item: SettingsItem,
  query: string,
  categoryLabel: string | undefined,
): number | null {
  let best: number | null = null;
  const fields = [
    item.label,
    item.description,
    ...item.aliases,
    item.displayValue,
    ...(categoryLabel ? [categoryLabel] : []),
  ];
  for (const field of fields) {
    const normalized = normalizeSearchText(field);
    const score = normalized === query
      ? 0
      : normalized.startsWith(query)
        ? 1
        : normalized.includes(query)
          ? 2
          : null;
    if (score !== null && (best === null || score < best)) best = score;
  }
  return best;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function assertNever(value: never): never {
  throw new Error(`Unreachable settings value: ${String(value)}`);
}
