export type SettingsSideEffectCode = "cross-disabled-kimi";

export interface DesktopSettingsSideEffectCopy {
  readonly kind: "info" | "error";
  readonly message: string;
}

export const DESKTOP_SETTINGS_SIDE_EFFECT_COPY = Object.freeze({
  "cross-disabled-kimi": Object.freeze({
    kind: "info",
    message: "Cross deaktiviert · Kimi Code unterstützt Cross nicht. Die nächste Nachricht läuft mit einem Modell.",
  }),
} satisfies Readonly<Record<SettingsSideEffectCode, DesktopSettingsSideEffectCopy>>);
