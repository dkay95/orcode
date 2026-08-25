import type {
  SettingsController,
  SettingsEditorRequest,
  SettingsEditorResult,
  SettingsIntent,
  SettingsViewModel,
} from "./settings-controller.js";

export interface SettingsSurface {
  begin(view: SettingsViewModel): Promise<void> | void;
  nextIntent(view: SettingsViewModel): Promise<SettingsIntent>;
  edit(request: SettingsEditorRequest): Promise<SettingsEditorResult>;
  end(): Promise<void> | void;
}

/**
 * One deliberately sequential event pump. At no point can an intent and an
 * editor be outstanding together, and cleanup has one owner: this `finally`.
 */
export async function runSettingsSession(
  controller: SettingsController,
  surface: SettingsSurface,
): Promise<void> {
  try {
    await surface.begin(controller.view);
    while (true) {
      const intent = await surface.nextIntent(controller.view);
      let effect = await controller.dispatch(intent);
      while (effect.kind === "edit") {
        const result = await surface.edit(effect.request);
        effect = await controller.completeEditor(effect.request, result);
      }
      if (effect.kind === "close") return;
    }
  } finally {
    await surface.end();
  }
}
