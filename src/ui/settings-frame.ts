import type {
  SettingsIntent,
  SettingsViewModel,
} from "../settings-controller.js";
import type {
  SettingsCategory,
  SettingsItem,
} from "../settings-registry.js";
import { composeLine, displayWidth, fitSpans } from "./compose.js";
import { MIN_HEIGHT, MIN_WIDTH, type Frame } from "./render-frame.js";
import {
  line,
  span,
  spansWidth,
  type Line,
  type Role,
  type Span,
} from "./spans.js";
import type { GlyphName, Theme } from "./theme.js";

export interface SettingsFrameInput {
  readonly width: number;
  readonly height: number;
  readonly theme: Theme;
  readonly view: SettingsViewModel;
  readonly brand: {
    readonly large: readonly string[];
    readonly compact: string;
    readonly visible: boolean;
  };
}

/** Rows and columns are one-based; the column interval is inclusive. */
export interface SettingsHitTarget {
  readonly row: number;
  readonly columnStart: number;
  readonly columnEnd: number;
  readonly intent: SettingsIntent;
}

export interface SettingsFrameResult {
  readonly frame: Frame;
  readonly hitTargets: readonly SettingsHitTarget[];
}

const TWO_COLUMN_MIN_WIDTH = 72;
const LARGE_BRAND_MIN_HEIGHT = 22;
const STACKED_CATEGORY_ROWS = 3;
const NORMAL_FOOTER = "↑↓ wählen · Enter ändern · / suchen · Esc zurück";
const SEARCH_FOOTER = "Suche · ↑↓ wählen · Enter ändern · Esc zurück";
const COMPACT_FOOTER = "↑↓ · Enter · / Suche · Esc zurück";
const COMPACT_SEARCH_FOOTER = "Suche · ↑↓ · Enter · Esc zurück";
const RESIZE_MESSAGE = `Fenster vergrößern · mindestens ${MIN_WIDTH}×${MIN_HEIGHT}`;

interface IndexedCategory {
  readonly category: SettingsCategory;
  readonly ordinal: number;
}

interface ItemRow {
  readonly spans: readonly Span[];
  readonly item?: SettingsItem;
}

function dimensions(input: SettingsFrameInput): {
  width: number;
  height: number;
  usableWidth: number;
} {
  const width = Number.isFinite(input.width) ? Math.max(0, Math.floor(input.width)) : 0;
  const height = Number.isFinite(input.height) ? Math.max(0, Math.floor(input.height)) : 0;
  return { width, height, usableWidth: Math.max(0, width - 1) };
}

/** Removes terminal controls while preserving printable Unicode clusters such as ZWJ emoji. */
function safeText(value: string): string {
  return value
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/gu, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "");
}

function safeGlyph(theme: Theme, name: GlyphName, fallback: string): string {
  const value = safeText(theme.glyph(name));
  return displayWidth(value) > 0 ? value : fallback;
}

function fittedLine(spans: readonly Span[], width: number, ellipsis: string): Line {
  return line(...fitSpans(spans, width, ellipsis));
}

function paddedCell(spans: readonly Span[], width: number, ellipsis: string): Span[] {
  const fitted = fitSpans(spans, width, ellipsis);
  const padding = Math.max(0, width - spansWidth(fitted));
  return padding > 0 ? [...fitted, span(" ".repeat(padding))] : fitted;
}

function dividerLine(theme: Theme, width: number, ellipsis: string): Line {
  const divider = safeGlyph(theme, "divider", "-");
  const cellWidth = Math.max(1, displayWidth(divider));
  const repeated = divider.repeat(Math.ceil(width / cellWidth));
  return fittedLine([span(repeated, "structure")], width, ellipsis);
}

function titleStatus(view: SettingsViewModel): string | null {
  if (view.readOnlyReason) return "Schreibgeschützt";
  if (view.runActive) return "Lauf aktiv";
  return null;
}

function titleLine(
  input: SettingsFrameInput,
  width: number,
  compactBrand: boolean,
  ellipsis: string,
): Line {
  const title = compactBrand && input.brand.visible
    ? `${safeText(input.brand.compact)}  ORCODE · Einstellungen`
    : "ORCODE · Einstellungen";
  const status = titleStatus(input.view);
  return composeLine(
    [
      {
        spans: [span(title, "accent", { bold: true })],
        align: "left",
        priority: 100,
      },
      ...(status
        ? [{
            spans: [span(safeText(status), input.view.readOnlyReason ? "warn" : "active")],
            align: "right" as const,
            priority: 90,
          }]
        : []),
    ],
    width,
    { ellipsis },
  );
}

function categorySpans(
  input: SettingsFrameInput,
  indexed: IndexedCategory,
  marker: string,
): Span[] {
  const selected = indexed.category.id === input.view.selectedCategoryId;
  return [
    span(`${selected ? marker : " "} ${indexed.ordinal} `, selected ? "active" : "muted"),
    span(safeText(indexed.category.label), selected ? "active" : "text", selected ? { bold: true } : undefined),
  ];
}

function itemPrimarySpans(
  input: SettingsFrameInput,
  item: SettingsItem,
  marker: string,
): Span[] {
  const selected = item.id === input.view.selectedItemId;
  const value = safeText(item.displayValue);
  return [
    span(`${selected ? marker : " "} `, selected ? "active" : "muted"),
    span(safeText(item.label), selected ? "active" : "text", selected ? { bold: true } : undefined),
    ...(displayWidth(value) > 0 ? [span(" · ", "structure"), span(value, "text")] : []),
  ];
}

function itemPair(input: SettingsFrameInput, item: SettingsItem, marker: string): readonly ItemRow[] {
  return [
    { spans: itemPrimarySpans(input, item, marker), item },
    {
      spans: item.disabledReason
        ? [span("  Gesperrt · ", "warn"), span(safeText(item.disabledReason), "warn")]
        : [span("  ", "muted"), span(safeText(item.description), "muted")],
    },
  ];
}

/** Windows whole primary/detail pairs so keyboard focus and its reason never separate. */
function visibleItemRows(
  input: SettingsFrameInput,
  marker: string,
  rowCapacity: number,
): readonly ItemRow[] {
  if (rowCapacity <= 0) return [];
  if (input.view.items.length === 0) {
    return [{ spans: [span("Keine Treffer", "muted")] }];
  }
  const pairCapacity = Math.floor(rowCapacity / 2);
  if (pairCapacity <= 0) return [];
  const selectedIndex = input.view.items.findIndex(
    (item) => item.id === input.view.selectedItemId,
  );
  const visibleItems = windowAround(input.view.items, selectedIndex, pairCapacity);
  return visibleItems.flatMap((item) => itemPair(input, item, marker));
}

function selectedCategoryLabel(view: SettingsViewModel): string {
  return safeText(
    view.categories.find((category) => category.id === view.selectedCategoryId)?.label
      ?? "Einstellungen",
  );
}

function itemHeading(view: SettingsViewModel): string {
  if (view.search.active) {
    return `Suche · "${safeText(view.search.query)}"`;
  }
  return `Einstellungen · ${selectedCategoryLabel(view)}`;
}

function windowAround<T>(values: readonly T[], selectedIndex: number, count: number): readonly T[] {
  if (count <= 0 || values.length === 0) return [];
  if (values.length <= count) return values;
  const safeIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const before = Math.floor((count - 1) / 2);
  const start = Math.min(
    Math.max(0, safeIndex - before),
    Math.max(0, values.length - count),
  );
  return values.slice(start, start + count);
}

function indexedCategories(view: SettingsViewModel): readonly IndexedCategory[] {
  return view.categories.map((category, index) => ({
    category,
    ordinal: index + 1,
  }));
}

function addHitTarget(
  hitTargets: SettingsHitTarget[],
  row: number,
  columnStart: number,
  visibleSpans: readonly Span[],
  maximumColumn: number,
  intent: SettingsIntent,
): void {
  const visibleWidth = spansWidth(visibleSpans);
  if (visibleWidth <= 0 || columnStart > maximumColumn) return;
  hitTargets.push({
    row,
    columnStart,
    columnEnd: Math.min(maximumColumn, columnStart + visibleWidth - 1),
    intent,
  });
}

function renderWideBody(
  input: SettingsFrameInput,
  lines: Line[],
  hitTargets: SettingsHitTarget[],
  availableRows: number,
  usableWidth: number,
  marker: string,
  ellipsis: string,
): void {
  if (availableRows <= 0) return;
  const leftWidth = Math.min(30, Math.max(26, Math.floor(usableWidth * 0.28)));
  const separator = " │ ";
  const separatorWidth = displayWidth(separator);
  const rightWidth = Math.max(0, usableWidth - leftWidth - separatorWidth);

  const combine = (left: readonly Span[], right: readonly Span[]): Line => line(
    ...paddedCell(left, leftWidth, ellipsis),
    span(separator, "structure"),
    ...fitSpans(right, rightWidth, ellipsis),
  );

  lines.push(combine(
    [span("Bereiche", "muted", { bold: true })],
    [span(itemHeading(input.view), "muted", { bold: true })],
  ));
  const contentRows = Math.max(0, availableRows - 1);
  const indexed = indexedCategories(input.view);
  const selectedCategoryIndex = indexed.findIndex(
    ({ category }) => category.id === input.view.selectedCategoryId,
  );
  const categories = windowAround(indexed, selectedCategoryIndex, Math.min(6, contentRows));
  const items = visibleItemRows(input, marker, contentRows);
  const rowCount = Math.min(contentRows, Math.max(categories.length, items.length));

  for (let index = 0; index < rowCount; index += 1) {
    const category = categories[index];
    const item = items[index];
    const left = category ? categorySpans(input, category, marker) : [];
    const right = item?.spans ?? [];
    lines.push(combine(left, right));
    const row = lines.length;
    if (category) {
      addHitTarget(
        hitTargets,
        row,
        1,
        fitSpans(left, leftWidth, ellipsis),
        leftWidth,
        { kind: "category", categoryId: category.category.id },
      );
    }
    if (item?.item) {
      const fitted = fitSpans(right, rightWidth, ellipsis);
      addHitTarget(
        hitTargets,
        row,
        leftWidth + separatorWidth + 1,
        fitted,
        usableWidth,
        { kind: "select-item", itemId: item.item.id },
      );
    }
  }
}

function renderStackedBody(
  input: SettingsFrameInput,
  lines: Line[],
  hitTargets: SettingsHitTarget[],
  availableRows: number,
  usableWidth: number,
  marker: string,
  ellipsis: string,
): void {
  if (availableRows <= 0) return;
  const indexed = indexedCategories(input.view);
  const selectedCategoryIndex = indexed.findIndex(
    ({ category }) => category.id === input.view.selectedCategoryId,
  );

  if (availableRows < 5) {
    const selectedCategory = windowAround(indexed, selectedCategoryIndex, 1)[0];
    if (selectedCategory) {
      const content = categorySpans(input, selectedCategory, marker);
      const fitted = fitSpans(content, usableWidth, ellipsis);
      lines.push(line(...fitted));
      addHitTarget(
        hitTargets,
        lines.length,
        1,
        fitted,
        usableWidth,
        { kind: "category", categoryId: selectedCategory.category.id },
      );
    }
    const remaining = Math.max(0, availableRows - (selectedCategory ? 1 : 0));
    for (const item of visibleItemRows(input, marker, remaining)) {
      const fitted = fitSpans(item.spans, usableWidth, ellipsis);
      lines.push(line(...fitted));
      if (item.item) {
        addHitTarget(
          hitTargets,
          lines.length,
          1,
          fitted,
          usableWidth,
          { kind: "select-item", itemId: item.item.id },
        );
      }
    }
    return;
  }

  lines.push(fittedLine([span("Bereiche", "muted", { bold: true })], usableWidth, ellipsis));
  let rowsLeft = availableRows - 1;
  if (rowsLeft <= 0) return;

  const categoryCount = Math.min(
    STACKED_CATEGORY_ROWS,
    indexed.length,
    Math.max(1, availableRows - 4),
  );
  const categories = windowAround(indexed, selectedCategoryIndex, categoryCount);
  for (const category of categories) {
    const content = categorySpans(input, category, marker);
    const fitted = fitSpans(content, usableWidth, ellipsis);
    lines.push(line(...fitted));
    addHitTarget(
      hitTargets,
      lines.length,
      1,
      fitted,
      usableWidth,
      { kind: "category", categoryId: category.category.id },
    );
    rowsLeft -= 1;
  }
  if (rowsLeft <= 0) return;

  lines.push(fittedLine(
    [span(itemHeading(input.view), "muted", { bold: true })],
    usableWidth,
    ellipsis,
  ));
  rowsLeft -= 1;
  if (rowsLeft <= 0) return;

  for (const item of visibleItemRows(input, marker, rowsLeft)) {
    const fitted = fitSpans(item.spans, usableWidth, ellipsis);
    lines.push(line(...fitted));
    if (item.item) {
      addHitTarget(
        hitTargets,
        lines.length,
        1,
        fitted,
        usableWidth,
        { kind: "select-item", itemId: item.item.id },
      );
    }
  }
}

function noticeLine(
  input: SettingsFrameInput,
  width: number,
  ellipsis: string,
): Line {
  const notice = input.view.notice;
  if (!notice) return line();
  const [glyphName, fallback, role]: [GlyphName | null, string, Role] =
    notice.kind === "success"
      ? ["ok", "+", "ok"]
      : notice.kind === "error"
        ? ["failed", "x", "danger"]
        : [null, "i", "text"];
  const glyph = glyphName ? safeGlyph(input.theme, glyphName, fallback) : fallback;
  return fittedLine(
    [span(`${glyph} `, role), span(safeText(notice.message), role)],
    width,
    ellipsis,
  );
}

function tinyFrame(input: SettingsFrameInput, usableWidth: number): SettingsFrameResult {
  const ellipsis = safeGlyph(input.theme, "ellipsis", "...");
  return {
    frame: {
      lines: [fittedLine([span(RESIZE_MESSAGE, "warn")], usableWidth, ellipsis)],
      chatHeight: 0,
      maxScrollOffset: 0,
      cursor: { row: 1, col: 1 },
    },
    hitTargets: [],
  };
}

export function buildSettingsFrame(input: SettingsFrameInput): SettingsFrameResult {
  const { width, height, usableWidth } = dimensions(input);
  if (width < MIN_WIDTH || height < MIN_HEIGHT) {
    return tinyFrame(input, usableWidth);
  }

  const marker = safeGlyph(input.theme, "marker", ">");
  const ellipsis = safeGlyph(input.theme, "ellipsis", "...");
  const lines: Line[] = [];
  const hitTargets: SettingsHitTarget[] = [];
  const largeBrand = input.brand.visible && height >= LARGE_BRAND_MIN_HEIGHT;

  if (largeBrand) {
    for (const brandLine of input.brand.large) {
      lines.push(fittedLine([span(safeText(brandLine), "accent")], usableWidth, ellipsis));
    }
    lines.push(line());
  }
  lines.push(titleLine(input, usableWidth, !largeBrand, ellipsis));
  lines.push(dividerLine(input.theme, usableWidth, ellipsis));

  const contentLimit = Math.max(0, height - 3);
  const availableRows = Math.max(0, contentLimit - lines.length);
  if (width >= TWO_COLUMN_MIN_WIDTH) {
    renderWideBody(
      input,
      lines,
      hitTargets,
      availableRows,
      usableWidth,
      marker,
      ellipsis,
    );
  } else {
    renderStackedBody(
      input,
      lines,
      hitTargets,
      availableRows,
      usableWidth,
      marker,
      ellipsis,
    );
  }

  if (lines.length > contentLimit) lines.splice(contentLimit);
  while (lines.length < contentLimit) lines.push(line());
  lines.push(noticeLine(input, usableWidth, ellipsis));
  lines.push(line());
  const fullFooter = input.view.search.active ? SEARCH_FOOTER : NORMAL_FOOTER;
  const compactFooter = input.view.search.active
    ? COMPACT_SEARCH_FOOTER
    : COMPACT_FOOTER;
  lines.push(fittedLine(
    [span(displayWidth(fullFooter) <= usableWidth ? fullFooter : compactFooter, "muted")],
    usableWidth,
    ellipsis,
  ));

  const visibleHitTargets = hitTargets.filter((target) => target.row <= contentLimit);
  const selectedItemTarget = visibleHitTargets.find(
    (target) => target.intent.kind === "select-item"
      && target.intent.itemId === input.view.selectedItemId,
  );
  const selectedCategoryTarget = visibleHitTargets.find(
    (target) => target.intent.kind === "category"
      && target.intent.categoryId === input.view.selectedCategoryId,
  );
  const cursorTarget = selectedItemTarget ?? selectedCategoryTarget;

  return {
    frame: {
      lines,
      chatHeight: contentLimit,
      maxScrollOffset: 0,
      cursor: cursorTarget
        ? { row: cursorTarget.row, col: cursorTarget.columnStart }
        : { row: height, col: 1 },
    },
    hitTargets: visibleHitTargets,
  };
}
