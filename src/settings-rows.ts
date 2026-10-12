/**
 * Settings' two presentation RULES, with no imports at all.
 *
 * V4-B's anatomy is the same on both surfaces — a tab bar, a growing crumb,
 * dense rows under `─ Section` headings — and two of its decisions are rules
 * rather than looks:
 *
 *  1. a heading is drawn only where the registry's `section` CHANGES between
 *     two consecutive rows, and never while a search is active (results span
 *     every category, so a category's own grouping says nothing about them);
 *  2. the crumb names where the reader is, and GROWS one step when an editor
 *     opens ("Beim Editieren wächst die Brotkrume mit" — the owner-approved
 *     mockup).
 *
 * Both were terminal-only, inside `ui/settings-frame.ts`, which reaches into
 * spans, themes and line composition. A second window re-deciding either one
 * is exactly the drift the iron rules call a finding — so they live here,
 * structurally typed and import-free, and both surfaces call them.
 *
 * Structural on purpose: `SettingsViewModel` lives in `settings-controller.ts`,
 * whose type graph reaches the whole core. These functions need four fields,
 * so they ask for four fields.
 */

export interface SettingsSectionedItem {
  readonly section?: string;
}

export type SettingsDisplayRow<T> =
  | { readonly kind: "heading"; readonly heading: string }
  | { readonly kind: "item"; readonly item: T };

/**
 * The body's rows in render order, with a heading wherever the section
 * changes. Rows carrying a section are contiguous by construction (the
 * registry's builder wraps its own sub-arrays), so the heading order is the
 * row order.
 */
export function settingsDisplayRows<T extends SettingsSectionedItem>(
  items: readonly T[],
  searchActive: boolean,
): SettingsDisplayRow<T>[] {
  const rows: SettingsDisplayRow<T>[] = [];
  let section: string | undefined;
  for (const item of items) {
    if (!searchActive && item.section && item.section !== section) {
      rows.push({ kind: "heading", heading: item.section });
    }
    section = item.section;
    rows.push({ kind: "item", item });
  }
  return rows;
}

export interface SettingsCrumbView {
  readonly categories: readonly { readonly id: string; readonly label: string }[];
  readonly selectedCategoryId: string;
  readonly search: { readonly active: boolean };
}

/**
 * `Settings › Models`, or `Settings › Search` while the query owns the
 * keyboard, or `Settings › Models › Main model` while an editor is open.
 *
 * Parts rather than a joined string, for the same reason the palette's crumb
 * is parts: the terminal joins with the theme's `chevron` glyph and the
 * window draws its own separator. One composition, two renderings.
 */
export function settingsCrumbParts(
  view: SettingsCrumbView,
  editorLabel?: string | null,
): string[] {
  const category = view.categories.find(
    (candidate) => candidate.id === view.selectedCategoryId,
  );
  const parts = ["Settings", view.search.active ? "Search" : category?.label ?? "Settings"];
  if (editorLabel) parts.push(editorLabel);
  return parts;
}
