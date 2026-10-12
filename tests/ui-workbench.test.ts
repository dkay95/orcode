import assert from "node:assert/strict";
import test from "node:test";

import { routeCoreCompact, routeCoreLarge } from "../src/branding.js";
import { buildDashboardFrame, type DashboardFrameInput, type DashboardState } from "../src/ui/dashboard-frame.js";
import { lineWidth, plainText, spansWidth, type Line } from "../src/ui/spans.js";
import { createTheme } from "../src/ui/theme.js";
import { workbenchAlternatives, type WorkbenchInput } from "../src/ui/workbench.js";

const state: DashboardState = {
  workspace: "/workspace/routercode",
  model: "openrouter/auto",
  resolvedModel: "moonshotai/kimi-k3",
  approval: "ask",
  reasoning: "high",
  maxCost: "$1.00",
  maxSteps: 12,
};

const brand = {
  showLargeLogo: true,
  showHeaderMark: true,
  largeLines: routeCoreLarge("ascii"),
  compactMark: routeCoreCompact("ascii"),
  // D8d: an arbitrary fixture value, deliberately distinct from the real
  // package.json version so these pins never drift just because the
  // project's own version number changes.
  version: "9.9.9",
};

function frame(overrides: Partial<DashboardFrameInput> = {}) {
  return buildDashboardFrame({
    width: 100,
    height: 28,
    theme: createTheme({ level: 0, ascii: true }),
    state,
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "Ready",
    brand,
    quickGroups: [
      { label: "/model", hint: "Modell wählen" },
      { label: "/new", hint: "Neuen Chat beginnen" },
      { label: "/verify", hint: "Änderungen prüfen" },
    ],
    ...overrides,
  });
}

function text(lines: readonly Line[]): string {
  return lines.map(plainText).join("\n");
}

test("the rich hub shows the box, a Recent heading, and the fixed quick actions — no generic invitation", () => {
  const rendered = text(frame().lines);

  assert.match(rendered, /---------\*/);
  assert.match(rendered, /^Recent$/m);
  assert.match(rendered, /\/model/);
  assert.match(rendered, /\/new/);
  assert.match(rendered, /\/verify/);
  // Controller ruling 1 (D8) drops the generic "What would you like to do?"
  // invitation from the hub itself — the "Recent" heading and the fixed
  // actions' own human-readable labels are self-explanatory now. It only
  // ever shows again as the absolute rock-bottom degrade (see the ladder
  // test below).
  assert.doesNotMatch(rendered, /What would you like to do\?/);
});

test("D8d: the hub's brand block is top-anchored — content starts at line 0, empty space grows below it toward the divider", () => {
  // A run transcript keeps its own bottom-up flow (R8, render-frame.ts) —
  // this ruling is scoped to the pure hub state alone. Before D8d, the
  // hub's brand block rendered as `expansion` (render-frame.ts), which
  // always sits immediately ABOVE the divider; the blank filler that pads
  // out the rest of the frame's height was pushed BEFORE it, producing the
  // owner-reported layout: a void filling most of the screen, then a tiny
  // brand block glued to the divider. `height: 24` here is tall enough that
  // the box + Recent + quick actions do not fill the whole frame, so real
  // blank filler is guaranteed to exist for this pin to be meaningful.
  const rendered = frame({ height: 24 });
  const lines = rendered.lines.map(plainText);
  const divider = lines.findIndex((line) => /^-{10,}$/.test(line));
  assert.ok(divider > 0, "the frame must render its own divider");

  // Top-anchored: the very first line is real content, never blank filler.
  assert.notEqual(lines[0]!.trim(), "", "the brand block starts at the top of the frame, not below a void");

  // The content block (box/mark, Recent, quick actions) is one contiguous
  // run starting at line 0; everything from the end of that run down to the
  // divider is blank filler. Find the last non-blank content line, then
  // assert every line between it and the divider is blank.
  const contentLines = lines.slice(0, divider);
  let lastContentLine = -1;
  contentLines.forEach((line, index) => {
    if (line.trim() !== "") lastContentLine = index;
  });
  assert.ok(lastContentLine >= 0, "there must be some brand-block content above the divider");
  assert.ok(
    lastContentLine < divider - 1,
    "height: 24 must leave real blank filler below the content — otherwise this pin cannot distinguish top- from bottom-anchoring",
  );
  for (let index = lastContentLine + 1; index < divider; index += 1) {
    assert.equal(lines[index], "", `line ${index} (between the brand block and the divider) must be blank filler, growing beneath the content`);
  }
});

test("the hub's degrade ladder: full mark, to box-only, to compact mark, to the bare invitation", () => {
  // Breakpoints re-measured for D8d, with justification: the hub no longer
  // reserves MIN_STREAM (5) blank filler rows it was never going to use
  // (render-frame.ts's `isHub` floor) and no longer duplicates the folder
  // path in a plain header above the box (the box absorbs it) — both used to
  // cost real rows the candidate ladder had to budget for, so every tier now
  // fits at a SHORTER height than the pre-D8d ladder needed. Each height
  // below sits solidly inside its tier's band, away from the exact boundary,
  // so a future one-row nudge to the box/Recent/actions content doesn't flip
  // this pin by accident.
  const full = text(frame({ height: 28 }).lines);
  const boxOnly = text(frame({ height: 20 }).lines);
  const compact = text(frame({ height: 12 }).lines);
  const bare = text(frame({ height: 8 }).lines);

  assert.match(full, /---------\*/);
  assert.match(full, /^Recent$/m);

  assert.doesNotMatch(boxOnly, /---------\*/);
  // The header row's own wording changed too (D8d): `orcode · Route Core`
  // became `ORCODE <version>` — one source for the wordmark
  // (`ROUTE_CORE_WORDMARK`, branding.ts) and the version
  // (`readPackageVersion`, branding.ts), matching the calibration
  // `orcode --version`/the plain banner already use. `Route     ` (the row
  // label, five trailing spaces) is the box's own content, present in this
  // tier and the full tier but not the compact mark or bare tiers below —
  // the more specific discriminator between "the box itself" and just the
  // wordmark text, which the compact tier's own one-liner also contains.
  // Not line-anchored: the box border's `| ` prefix sits before it.
  assert.match(boxOnly, /ORCODE 9\.9\.9/);
  assert.match(boxOnly, /Route {5}/);
  assert.match(boxOnly, /^Recent$/m);

  assert.doesNotMatch(compact, /---------\*|Route {5}/);
  assert.match(compact, />-\* ORCODE 9\.9\.9/);
  assert.match(compact, /^Recent$/m);

  assert.doesNotMatch(bare, /---------\*|>-\* ORCODE|^Recent$/m);
  assert.match(bare, /What would you like to do\?/);
});

test("a disabled large logo still falls back to a plain invitation at 100x8", () => {
  const rendered = frame({
    width: 100,
    height: 8,
    brand: { ...brand, showLargeLogo: false },
  });

  // D8d appearance pin update, with justification: `chatHeight` used to be
  // floored at the render-frame `MIN_STREAM` constant (5) even at the hub,
  // where it is pure blank filler below the one-line invitation, never real
  // scrollback — hitting that floor here used to cost the status line itself
  // (render-frame.ts's own last-resort trim), a needless loss the D8d fix
  // removes by not enforcing MIN_STREAM at the hub at all. `chatHeight` is
  // now the honest leftover (4, exactly `height` minus the invitation line
  // and the surviving chrome) and the status line stays on screen instead.
  assert.equal(rendered.chatHeight, 4);
  assert.match(text(rendered.lines), /What would you like to do\?/);
  assert.doesNotMatch(text(rendered.lines), /\/model|\/settings|\/cross/);
  assert.match(text(rendered.lines), /ask/, "the identity status line survives instead of being dropped for headroom that was never real");
});

test("conversation removes start content and keeps compact route identity, model short on the status line", () => {
  const rendered = text(frame({
    blocks: [{ id: "user-1", kind: "user", text: "Bitte teste das", attachmentCount: 0, at: 0 }],
  }).lines);

  assert.match(rendered, />-\*/);
  // Controller decision B: the status line carries "model short" — no
  // provider prefix, no reasoning level, no provider name (none of that is
  // part of the spec's `<approval> · <model> · <branch> · costs` contract).
  assert.match(rendered, /kimi-k3/);
  assert.doesNotMatch(rendered, /moonshotai\/kimi-k3/);
  assert.doesNotMatch(rendered, /What would you like to do\?|---------\*/);
});

test("an empty transcript with the start picker open shows the hub above it, not blank rows", () => {
  const list = {
    entries: [
      { name: "＋ New Chat", description: "Starts without prior conversation context." },
      { name: "Chat A", description: "3 message(s)" },
    ],
    selectedIndex: 0,
    heading: "Chats · workspace",
  };
  const rendered = text(frame({ mode: "choice-picker", list, blocks: [] }).lines);

  // The Route Core mark's own middle route line — the fullest alternative
  // fits at this roomy size, exactly as it would with no picker open at all.
  assert.match(rendered, /---------\*/);
  assert.match(rendered, /^Recent$/m);
  assert.match(rendered, /\/model/);
  // The picker keeps its own heading and entries — filling the dead rows
  // above it is not a replacement for its content.
  assert.match(rendered, /Chats · workspace/);
  assert.match(rendered, /Chat A/);
});

test("a conversation behind the picker keeps current behavior: no workbench crowds the picker", () => {
  const list = {
    entries: [{ name: "Chat A", description: "3 message(s)" }],
    selectedIndex: 0,
    heading: "Chats · workspace",
  };
  const rendered = text(frame({
    mode: "choice-picker",
    list,
    blocks: [{ id: "user-1", kind: "user", text: "hi", attachmentCount: 0, at: 0 }],
  }).lines);

  assert.doesNotMatch(rendered, /What would you like to do\?|---------\*|>-\* ORCODE|^Recent$/m);
});

test("a tight terminal never shrinks the chat picker to make room for the empty-transcript hub", () => {
  const list = {
    entries: Array.from({ length: 6 }, (_, index) => ({
      name: `Chat ${index}`,
      description: `${index} message(s)`,
    })),
    selectedIndex: 0,
    heading: "Chats · workspace",
  };
  const tight = frame({ mode: "choice-picker", list, blocks: [], height: 9 });
  const rendered = text(tight.lines);

  // The picker itself is unclipped at this size: its own minimum-space logic
  // (blocks.length === 0 keeps `expansion` from ever being cleared) still
  // holds — full heading, its own row limit, and its own pagination footer.
  assert.match(rendered, /Chats · workspace/);
  assert.match(rendered, /Chat 0/);
  assert.match(rendered, /Chat 2/);
  assert.doesNotMatch(rendered, /Chat 3|Chat 4|Chat 5/);
  assert.match(rendered, /1 of 6/);
  // Too little room remains above the picker for the large or compact
  // mark — alternatives are atomic, so a half-drawn mark must never appear.
  assert.doesNotMatch(rendered, /---------\*/);
  assert.doesNotMatch(rendered, />-\* ORCODE/);
});

// ---------------------------------------------------------------------------
// D8d: the hub always shows its D8 rows — `❯─● ORCODE <version>`, the
// route/model row (or an honest fallback when genuinely none), Balance when
// known, and the context line — investigated and fixed at the root cause
// rather than patched at the rendering layer: a fresh/switched chat's
// `resolvedModel` is `""` (not `undefined`) between `cli.ts`'s reset and
// that chat's first completed run, and `resolvedModel ?? state.model` never
// falls through for an empty string (`??` only triggers on
// `null`/`undefined`) — exactly the state D8c's "land every launch on the
// hub with a fresh chat" produces on every single startup. `effectiveRoute`
// (dashboard-frame.ts) is the fix; these three tests pin its two branches
// plus the ordinary "everything is known" case together.
// ---------------------------------------------------------------------------

test("D8d: the hub always shows the wordmark+version, Route, and context rows — the D8 rows the owner's screenshot was missing", () => {
  const rendered = text(frame().lines);

  assert.match(rendered, /ORCODE 9\.9\.9/, "the header row carries the wordmark and the threaded package version, one source");
  assert.match(rendered, /Route {5}moonshotai\/kimi-k3/, "the Route row names the active route");
  assert.match(rendered, /\/workspace\/routercode - approvals ask/, "the one muted context line (folder · approvals · hint)");
});

test("D8d root-cause fix: a fresh/switched chat's empty resolvedModel (\"\", not undefined) falls back to the configured model — never a fabricated 'not set'", () => {
  const rendered = text(frame({
    // Exactly the shape `cli.ts`'s `resolvedModel` reset produces (D8c): the
    // configured route (`model`) is real and known the whole time, but
    // nothing has resolved yet for THIS chat.
    state: { ...state, resolvedModel: "", model: "anthropic/claude-sonnet-5" },
  }).lines);

  assert.match(rendered, /Route {5}anthropic\/claude-sonnet-5/);
  assert.doesNotMatch(rendered, /not set/);
});

test("D8d: genuinely no route configured shows the honest fallback, not a fabricated 'not set'", () => {
  const rendered = text(frame({
    state: { ...state, resolvedModel: "", model: "" },
  }).lines);

  assert.match(rendered, /No route configured - \/model picks one/);
  assert.doesNotMatch(rendered, /Route {5}/, "the labeled Route row is replaced outright by the honest sentence, not paired with it");
});

test("the welcome box's Balance row shows remaining credit and today's spend", () => {
  const rendered = text(frame({
    state: { ...state, balanceRemainingUsd: 12.48, dayUsd: 0.42 },
  }).lines);

  // `frame()` uses the ASCII theme, so the separator is the ascii pair " - ",
  // not the unicode " · " — this is the ASCII-parity fix itself (F6 sweep):
  // the row used to leak the unicode dot regardless of glyph mode.
  assert.match(rendered, /Balance\s+~\$12\.480 - \$0\.420 spent today/);
});

test("the Balance row reads provider-managed on a Kimi route, never a dollar figure", () => {
  const rendered = text(frame({
    state: { ...state, balanceProviderManaged: true, balanceRemainingUsd: 12.48, dayUsd: 0.42 },
  }).lines);

  assert.match(rendered, /Balance\s+provider-managed/);
  assert.doesNotMatch(rendered, /Balance.*\$12\.48/);
});

test("the Balance row is omitted entirely when no credits were ever fetched — never a fabricated number", () => {
  const rendered = text(frame({ state }).lines);

  assert.doesNotMatch(rendered, /Balance/);
});

// ---------------------------------------------------------------------------
// D6 (the cost thread): the Balance row's low-balance warn. `frame()` above
// always uses the ASCII/level-0 theme (`createTheme({ level: 0, ascii: true })`),
// so every assertion below already proves the NO_COLOR case — the "low"
// marker has to be real text, since colour carries no information here at all.
// ---------------------------------------------------------------------------

test("D6: below the configured threshold, the Balance row's figure gains an explicit 'low' marker, not just a colour change", () => {
  const rendered = text(frame({
    state: { ...state, balanceRemainingUsd: 1.5, lowBalanceThresholdUsd: 2, dayUsd: 0.42 },
  }).lines);

  assert.match(rendered, /Balance\s+~\$1\.500 - low - \$0\.420 spent today/);
});

test("D6: at or above the threshold, the Balance row stays exactly as it always was — no 'low' marker", () => {
  const rendered = text(frame({
    state: { ...state, balanceRemainingUsd: 2, lowBalanceThresholdUsd: 2, dayUsd: 0.42 },
  }).lines);

  assert.match(rendered, /Balance\s+~\$2\.000 - \$0\.420 spent today/);
  assert.doesNotMatch(rendered, /\blow\b/);
});

test("D6: a 0 threshold disables the Balance row's warn entirely, however small the remaining balance is", () => {
  const rendered = text(frame({
    state: { ...state, balanceRemainingUsd: 0.01, lowBalanceThresholdUsd: 0, dayUsd: 0.42 },
  }).lines);

  assert.match(rendered, /Balance\s+~\$0\.010 - \$0\.420 spent today/);
  assert.doesNotMatch(rendered, /\blow\b/);
});

test("D6: an unset lowBalanceThresholdUsd behaves like 0 (disabled) — a caller that never threads config through never fabricates a warn", () => {
  const rendered = text(frame({
    state: { ...state, balanceRemainingUsd: 0.01, dayUsd: 0.42 },
  }).lines);

  assert.doesNotMatch(rendered, /\blow\b/);
});

test("D6: the Balance row actually paints the warn role at a real colour level, not just the wording", () => {
  const [boxWelcome] = workbenchAlternatives(workbenchInput({
    theme: createTheme({ level: 1 }),
    balanceRemainingUsd: 1,
    lowBalanceThresholdUsd: 2,
    dayUsd: 0.42,
  }));

  const balanceLine = boxWelcome!.find((line) => plainText(line).includes("Balance"));
  assert.ok(balanceLine, "the Balance row must render");
  const warnSpan = balanceLine!.spans.find((span) => span.role === "warn");
  assert.ok(warnSpan, "some span in the Balance row must carry the warn role once low");
});

test("the Balance row sits above the one muted context line (Controller ruling 1, D8 reorder)", () => {
  const rendered = text(frame({
    state: { ...state, balanceRemainingUsd: 12.48 },
  }).lines).split("\n");

  const balanceIndex = rendered.findIndex((line) => line.includes("Balance"));
  const contextIndex = rendered.findIndex((line) => line.includes("approvals ask"));
  assert.ok(balanceIndex >= 0 && contextIndex >= 0, "both rows must render");
  assert.ok(balanceIndex < contextIndex, "Balance must render above the muted context line");
});

// These four tests use a short `/proj` workspace, not the file's default
// `/workspace/routercode` — the full folded line (folder + branch + approval
// + hint) legitimately exceeds the box's 56-char content cap with the
// longer path and would truncate with an ellipsis (that generic truncation
// behavior is `ui-compose.test.ts`'s `fitSpans` suite's concern, not this
// one's); a short path keeps these assertions about content, not clipping.

test("the one muted context line folds folder + branch + approval mode together, with the git branch appended", () => {
  const rendered = text(frame({
    state: { ...state, workspace: "/proj", projectStatus: "proj · Git main · Chat \"x\" · 1 message(s)" },
  }).lines);

  // ASCII theme (see comment above): separators are " - ".
  assert.match(rendered, /\/proj - main - approvals ask - \/approvals to change/);
  // No more per-field labels ("Folder", "Approvals") — this is now the one
  // unlabeled muted line, the same convention the bottom status line's own
  // permanent identity chrome already uses.
  assert.doesNotMatch(rendered, /^Folder\b/m);
  assert.doesNotMatch(rendered, /^Approvals\b/m);
});

test("the context line omits the branch segment outside a git repository", () => {
  const rendered = text(frame({
    state: { ...state, workspace: "/proj", projectStatus: "proj · Chat \"x\" · 1 message(s)" },
  }).lines);

  const contextLine = rendered.split("\n").find((line) => line.includes("approvals ask"));
  assert.ok(contextLine, "the context line must render");
  assert.match(contextLine!, /^\| \/proj - approvals ask - \/approvals to change/);
});

test("allow-all replaces only the approval-mode segment with the full warn treatment — folder/branch stay, the warning never shrinks", () => {
  const rendered = text(frame({
    state: {
      ...state,
      workspace: "/proj",
      approval: "allow-all",
      projectStatus: "proj · Git main · Chat \"x\" · 1 message(s)",
    },
  }).lines);

  // ASCII theme (see comment above): the separator is " - ".
  assert.match(rendered, /\/proj - main - allow-all - every action runs unasked/);
  assert.doesNotMatch(rendered, /\/approvals to change/);
});

test("other approval modes keep the muted \"/approvals to change\" hint on the context line", () => {
  const rendered = text(frame({ state: { ...state, workspace: "/proj", approval: "ask" } }).lines);

  assert.match(rendered, /approvals ask - \/approvals to change/);
});

// ---------------------------------------------------------------------------
// Phase 10 — the welcome box's Cross row, once persistent Cross mode is
// armed for this chat.
// ---------------------------------------------------------------------------

test("the welcome box's Cross row appears once persistent Cross mode is armed, with the short pair and a stop hint", () => {
  // Short synthetic labels (not full realistic model ids): the box's content
  // width caps at MAX_BOX_INNER (56, see workbench.ts) like every other row,
  // so a long real model pair legitimately truncates with an ellipsis the
  // same way a long context line already does — that generic behavior is
  // covered by ui-compose.test.ts's fitSpans suite, not re-asserted here.
  const rendered = text(frame({
    state: { ...state, crossArmed: { lead: "vendor/lead", challenger: "vendor/chal" } },
  }).lines);

  // ASCII theme (see comment above): separators are " - "; "armed" carries
  // the meaning in wording (NO_COLOR-safe), the same treatment allow-all
  // gets on the context line above. Labels are shortened the same way the
  // status line's own model segment is (shortModelName), so "vendor/" is
  // stripped.
  assert.match(rendered, /Cross\s+armed - lead\+chal - \/cross off to stop/);
});

test("the Cross row is omitted entirely when persistent Cross mode is not armed", () => {
  const rendered = text(frame({ state }).lines);

  assert.doesNotMatch(rendered, /\bCross\b/);
});

// Owner ruling (fix round 1): a PENDING one-shot must read as visibly
// distinct from persistent armed mode — "waiting-to-spend must be visible
// like armed-to-spend."
test("the welcome box's Cross row reads 'waiting', not 'armed', for a pending one-shot", () => {
  const rendered = text(frame({
    state: { ...state, crossArmed: { lead: "vendor/lead", challenger: "vendor/chal", oneShot: true } },
  }).lines);

  assert.match(rendered, /Cross\s+waiting - lead\+chal - \/cross off to stop/);
  assert.doesNotMatch(rendered, /Cross\s+armed/);
});

// ---------------------------------------------------------------------------
// D8 — the neutral start hub's "Recent" section and the combined selection
// list it shares with the fixed quick actions (Controller ruling 2/3/5).
// ---------------------------------------------------------------------------

test("a current-folder Recent row carries no ~folder suffix", () => {
  const rendered = text(frame({
    state: {
      ...state,
      recentChats: [
        {
          id: "a",
          title: "Same folder chat",
          turnCount: 3,
          costUsd: 1.234,
          updatedAt: Date.now() - 2 * 60 * 60_000,
          workspace: state.workspace,
        },
      ],
    },
  }).lines);

  // FIX-21 finding 5: `formatChatRow` (utils.ts) used to hardcode the
  // unicode " · " separator, so this row stayed unicode in ASCII glyph mode
  // while every glyph around it asciified — the audit frame-verified the
  // leak. The composer now takes `theme.glyph("separator")` from its caller,
  // and `frame()`'s theme here is the ASCII one.
  assert.match(rendered, /Same folder chat\s+3 messages - \$1\.234 - 2h ago/);
  assert.doesNotMatch(rendered, /Same folder chat.*workspace/);
});

test("a foreign Recent row carries its ~folder suffix and model short, exactly like the /chats row format", () => {
  const rendered = text(frame({
    homeDir: "/workspace",
    state: {
      ...state,
      recentChats: [
        {
          id: "b",
          title: "Other folder chat",
          turnCount: 1,
          costUsd: 0,
          costKnowledge: "unknown",
          model: "vendor/model-x",
          updatedAt: Date.now() - 60_000,
          workspace: "/workspace/elsewhere",
        },
      ],
    },
  }).lines);

  assert.match(
    rendered,
    /Other folder chat\s+1 message - provider-managed \/ unknown - model-x - 1m ago - ~\/elsewhere/,
  );
});

test("D8d: a long ~folder suffix on a Recent row is width-clamped WITH the theme ellipsis glyph, never a raw mid-word cut", () => {
  // `actionLine` (workbench.ts) used to skip `fitSpans` entirely for the
  // un-highlighted branch — every Recent row except a highlighted one — so a
  // row whose `~folder` suffix (appended by `formatChatRow`, width-unaware
  // by design) ran past the frame's width was handed to the frame completely
  // unclamped. At a real terminal that row is however wide it naturally is;
  // the terminal itself then hard-wraps or truncates it on the next repaint,
  // mid-word, with no ellipsis at all — the exact owner-reported
  // `~/projekt/rout` symptom this pins against.
  // Matches `frame()`'s own internal theme exactly (ASCII, level 0) — needed
  // here only to name the expected ellipsis glyph, not to build the frame.
  const theme = createTheme({ level: 0, ascii: true });
  const narrowWidth = 60;
  const result = frame({
    width: narrowWidth,
    homeDir: "/workspace",
    state: {
      ...state,
      recentChats: [
        {
          id: "b",
          title: "Fix the login bug",
          turnCount: 4,
          costUsd: 0.02,
          model: "moonshotai/kimi-k3",
          updatedAt: Date.now() - 60_000,
          workspace: "/workspace/routercode-some-other-long-folder-name",
        },
      ],
    },
  });

  const usableWidth = narrowWidth - 1;
  const row = result.lines.find((line) => plainText(line).includes("Fix the login bug"));
  assert.ok(row, "the Recent row must still render, just clamped");
  assert.ok(
    lineWidth(row!) <= usableWidth,
    `the row must never exceed the frame's usable width (${usableWidth}), got ${lineWidth(row!)}`,
  );
  // ASCII theme (as used by this file's `frame()`): the ellipsis glyph
  // degrades to a single "." (F6 ASCII sweep, theme.ts) — still exactly one
  // cell, the same single-cell contract the unicode "…" carries.
  const rendered = plainText(row!);
  assert.equal(rendered.at(-1), theme.glyph("ellipsis"), "a clamped row must end in the theme's own ellipsis glyph");
  assert.doesNotMatch(
    rendered,
    /routercode-some-other-long-folder-name$/,
    "the full unabbreviated folder suffix must not survive uncut at this width",
  );
});

test("no chats anywhere shows one muted invitation line under Recent — not a dead-end, no filler rows", () => {
  const rendered = text(frame({ state: { ...state, recentChats: [] } }).lines);

  assert.match(rendered, /^Recent$/m);
  // The dash comes from theme.glyph("emdash") since the D5 merge — this
  // fixture's ascii theme renders it as "-", which is the point of the fix.
  assert.match(rendered, /No chats yet - type below to start your first one\./);
});

test("fewer than 4 chats shows exactly what exists — no filler rows", () => {
  const rendered = text(frame({
    state: {
      ...state,
      recentChats: [
        { id: "a", title: "Only chat", turnCount: 1, costUsd: 0.01, updatedAt: Date.now(), workspace: state.workspace },
      ],
    },
  }).lines);

  assert.match(rendered, /Only chat\s+1 message - \$0\.010 - just now/);
  assert.doesNotMatch(rendered, /No chats yet/);
});

test("the combined selection index covers Recent rows first, then the fixed quick actions", () => {
  const recentChats = [
    { id: "a", title: "First recent", turnCount: 1, costUsd: 0.01, updatedAt: Date.now(), workspace: state.workspace },
    { id: "b", title: "Second recent", turnCount: 1, costUsd: 0.01, updatedAt: Date.now(), workspace: state.workspace },
  ];
  const withIndex = (index: number) =>
    text(frame({ state: { ...state, recentChats }, quickActionIndex: index }).lines).split("\n");

  const markerLine = (lines: string[], label: string) => lines.find((line) => line.includes(label));

  assert.match(markerLine(withIndex(0), "First recent")!, /^> First recent\b/);
  assert.doesNotMatch(markerLine(withIndex(0), "Second recent")!, /^> Second recent\b/);

  assert.match(markerLine(withIndex(1), "Second recent")!, /^> Second recent\b/);
  assert.doesNotMatch(markerLine(withIndex(1), "First recent")!, /^> First recent\b/);

  // Index 2 is past both Recent rows — it lands on the FIRST fixed quick
  // action (offset = recentChats.length), never re-wrapping onto a Recent
  // row (Controller ruling 2: one combined list, generalized, not two).
  assert.match(markerLine(withIndex(2), "/model")!, /^> \/model\b/);
});

// ---------------------------------------------------------------------------
// D1 bar-consistency addendum — the hub's selected row must carry the SAME
// full-row inverse bar `list-core.ts`'s pickers/command menu use everywhere
// else. D8b (the align-the-hub-onto-list-core pass) replaced the hand-copy
// this addendum originally shipped with a direct delegation to
// `list-core.ts`'s own exported `fillSelectionBar` (see `actionLine`'s doc
// comment in `workbench.ts`) — the hand-copy had already drifted from its
// source of truth once (a width bug, D8 fix round 1, covered below) before
// this pass closed it for good. `list-core.ts`'s `ListView`/`buildListLines`
// pipeline stays unused here regardless: its description/"n of total" column
// shape does not fit this fixed, unpaginated row list. These two tests
// exercise `workbenchAlternatives` directly against its `Line`/`Span` model
// — role and width, not painted ANSI text — since `plainText` (used
// everywhere else in this file) strips roles and would not see the bar at
// all.
// ---------------------------------------------------------------------------

function workbenchInput(overrides: Partial<WorkbenchInput> = {}): WorkbenchInput {
  return {
    branding: { showLargeLogo: false, showHeaderMark: true, largeLines: [], compactMark: ">-*", version: "9.9.9" },
    recentChats: [],
    quickGroups: [
      { label: "New chat", hint: "Start a separate chat in this folder" },
      { label: "All chats", hint: "Choose from every chat, every folder" },
    ],
    theme: createTheme({ level: 0, ascii: true }),
    width: 60,
    workspace: "/workspace/routercode",
    route: "kimi-k3",
    approval: "ask",
    ...overrides,
  };
}

test("at a real colour level, the hub's selected row is one continuous inverse bar padded to the full row width", () => {
  const width = 60;
  const [boxWelcome] = workbenchAlternatives(workbenchInput({
    theme: createTheme({ level: 1 }),
    width,
    quickActionIndex: 1, // "All chats" — recentChats is empty, so offset 0
  }));

  const selected = boxWelcome!.find((line) => plainText(line).includes("All chats"));
  assert.ok(selected, "the selected row must render");
  assert.ok(
    selected!.spans.every((item) => item.role === "inverse"),
    "every span in the selected row must share the inverse role — one continuous bar, not just a coloured marker",
  );
  assert.equal(
    spansWidth(selected!.spans),
    width,
    "the bar must pad out with more inverse-painted spaces to the full row width",
  );

  const unselected = boxWelcome!.find((line) => plainText(line).includes("New chat"));
  assert.ok(unselected, "the unselected row must still render");
  assert.ok(
    unselected!.spans.every((item) => item.role !== "inverse"),
    "an unselected row must never carry the inverse role",
  );
});

// D8b resolution (closes the disclosed Minor from the D8 review): pre-D8b,
// this test pinned a level-0 divergence from `list-core.ts`'s own convention
// — the hand-copied `actionLine` special-cased `theme.level === 0` to skip
// both the inverse role and the trailing pad-to-width, on the theory that
// invisible padding bytes were "pointless" in a NO_COLOR transcript.
// `list-core.ts`'s `buildListLines`/`fillSelectionBar` never made that
// exception — they always emit the inverse role and always pad to width, at
// every colour level, and rely entirely on `theme.ts`'s `paintSpan` (which
// short-circuits every role to plain text at level 0) to make it invisible
// on a real terminal. Resolving in `list-core.ts`'s favor — rather than
// special-casing level 0 here — is what makes `fillSelectionBar` a true
// shared mechanic instead of a "shared except at level 0" one, so this test
// now pins the SAME behavior `buildListLines`'s own active rows already
// have (see `ui-list-core.test.ts` or the equivalent picker-level coverage
// for that side): the row still carries role "inverse" in its `Span` data
// and is still padded out to the full row width, in bytes — only the
// painted ANSI text differs from a real colour level, and that degradation
// is `paintSpan`'s job, not this row-building step's.
test("at colour level 0 the selected row still carries list-core.ts's full inverse bar in its span data — paintSpan (theme.ts), not the row builder, is what makes it invisible", () => {
  const width = 60;
  const [boxWelcome] = workbenchAlternatives(workbenchInput({
    theme: createTheme({ level: 0, ascii: true }),
    width,
    quickActionIndex: 0,
  }));

  const selected = boxWelcome!.find((line) => plainText(line).includes("New chat"));
  assert.ok(selected, "the selected row must render");
  assert.ok(
    selected!.spans.every((item) => item.role === "inverse"),
    "list-core.ts's fillSelectionBar never special-cases level 0 — the row must not compensate by withholding the inverse role itself",
  );
  assert.equal(
    spansWidth(selected!.spans),
    width,
    "fillSelectionBar pads to the full row width unconditionally; the padding bytes are real but invisible once painted at level 0",
  );

  const unselected = boxWelcome!.find((line) => plainText(line).includes("All chats"));
  assert.ok(unselected, "the unselected row must still render");
  assert.ok(
    unselected!.spans.every((item) => item.role !== "inverse"),
    "an unselected row must never carry the inverse role, at any colour level",
  );
});

// Fix round 1 (reviewer finding, IMPORTANT): the two tests above call
// `workbenchAlternatives` directly with an already-adjusted `width`, so they
// pin `workbenchAlternatives`'s OWN contract correctly but can never catch a
// bug in what `dashboard-frame.ts` passes it. `dashboard-frame.ts` was
// passing the frame's raw `width` instead of `usableWidth` (`width - 1`, the
// same value every other full-width line in the frame — header, divider,
// status, the /chats picker's own bar — is built against), so the hub's
// selected-row bar rendered exactly one column wider than everything else
// around it. This test drives the FULL `buildDashboardFrame` pipeline (not
// `workbenchAlternatives` in isolation) and cross-checks the bar's width
// against the frame's own divider line, so a future regression of this
// exact kind fails here even if `workbenchAlternatives`'s own unit tests
// above stay green.
test("Fix round 1: the selected row's bar matches the frame's own divider width exactly — no 1-column overflow", () => {
  const width = 78;
  const theme = createTheme({ level: 1 });
  const result = buildDashboardFrame({
    width,
    height: 28,
    theme,
    state,
    blocks: [],
    mode: "input",
    input: "",
    cursor: 0,
    status: "Ready",
    brand,
    quickGroups: [
      { label: "/model", hint: "Modell wählen" },
      { label: "/new", hint: "Neuen Chat beginnen" },
    ],
    quickActionIndex: 0,
  });

  const divider = theme.glyph("divider");
  const dividerLine = result.lines.find((line) => {
    const rendered = plainText(line);
    return rendered.length > 0 && [...rendered].every((ch) => ch === divider);
  });
  assert.ok(dividerLine, "the frame must render its own full-width divider line");

  const barLine = result.lines.find((line) => line.spans.some((item) => item.role === "inverse"));
  assert.ok(barLine, "a real colour level must render the selected row as an inverse bar");

  assert.equal(
    lineWidth(barLine!),
    lineWidth(dividerLine!),
    "the selected-row bar must span exactly the frame's own usable width, matching the divider line column for column",
  );
});

test("a quick-action index paints exactly that row with the selection marker, others plain", () => {
  // ASCII theme (as used by this file's `frame()`): the marker degrades to
  // ">" — the same glyph as the input row's own gutter — so the assertion
  // anchors on the specific label right after it, not a bare glyph count.
  const withSelection = text(frame({ quickActionIndex: 1 }).lines).split("\n");
  const withoutSelection = text(frame().lines).split("\n");

  assert.ok(withSelection.some((line) => /^> \/new\b/.test(line)), "the selected row (/new) must carry the marker");
  assert.ok(!withSelection.some((line) => /^> \/model\b/.test(line)), "an unselected row must not carry the marker");
  assert.ok(!withSelection.some((line) => /^> \/verify\b/.test(line)), "an unselected row must not carry the marker");
  assert.ok(
    !withoutSelection.some((line) => /^> \//.test(line)),
    "with no selection, no quick-action row carries the marker",
  );
});

test("the composer's placeholder names the current folder over the empty hub", () => {
  const rendered = text(frame().lines);

  assert.match(rendered, /Type to start a new chat in \/workspace\/routercode/);
});

test("mid-conversation the composer keeps the generic placeholder, not the folder-naming one", () => {
  const rendered = text(frame({
    blocks: [{ id: "user-1", kind: "user", text: "hi", attachmentCount: 0, at: 0 }],
    mode: "input",
  }).lines);

  assert.match(rendered, /Describe your task/);
  assert.doesNotMatch(rendered, /Type to start a new chat/);
});

// ---------------------------------------------------------------------------
// D8 ruling 4 — identical everywhere: the hub's structure never varies with
// cwd, only the folder/branch text, the placeholder, and which rows carry a
// ~folder suffix.
// ---------------------------------------------------------------------------

test("the hub's structure is identical across two different folders, modulo the folder text itself", () => {
  const frameForWorkspace = (workspace: string) => text(frame({
    state: {
      ...state,
      workspace,
      recentChats: [
        { id: "a", title: "Local chat", turnCount: 2, costUsd: 0.02, updatedAt: Date.now() - 60_000, workspace },
      ],
    },
  }).lines).split("\n");

  // Same length on purpose: the welcome box "sizes to content" (pre-D8,
  // Terminal-Look spec principle 1) — a longer path legitimately widens the
  // box's own border, which is a sizing detail this test does not care
  // about. Same-length paths isolate the one thing ruling 4 actually binds:
  // the row STRUCTURE (same fields, same order), not incidental box width.
  const alpha = frameForWorkspace("/workspace/orcode");
  const beta = frameForWorkspace("/workspace/legacy");

  assert.equal(alpha.length, beta.length, "identical line count regardless of folder");
  for (let index = 0; index < alpha.length; index += 1) {
    const normalizedAlpha = alpha[index]!.split("/workspace/orcode").join("<WS>");
    const normalizedBeta = beta[index]!.split("/workspace/legacy").join("<WS>");
    assert.equal(
      normalizedAlpha,
      normalizedBeta,
      `line ${index} differs structurally: ${JSON.stringify(alpha[index])} vs ${JSON.stringify(beta[index])}`,
    );
  }
});

test("the Cross status notice uses the program's coding/review role language, not Lead/Challenger", () => {
  const rendered = text(frame({
    state: {
      ...state,
      cross: {
        sequence: 1,
        updatedAt: 0,
        phase: "Analysis",
        reason: null,
        verification: "not run",
        lead: "openrouter/vendor-a",
        challenger: "openrouter/vendor-b",
        active: true,
      },
    },
  }).lines);

  // ASCII theme (see comment above): the separator is " - ".
  assert.match(rendered, /Coding - openrouter\/vendor-a/);
  assert.match(rendered, /Review - openrouter\/vendor-b/);
  assert.doesNotMatch(rendered, /Lead -|Challenger -/);
});

test("FIX-18 (F3): a claimed route the runtime says cannot run carries the honest warn state and the one working step", () => {
  const rendered = text(frame({
    state: { ...state, resolvedModel: "", model: "openrouter/auto", routeNotConnected: true },
  }).lines);

  assert.match(rendered, /Route {5}openrouter\/auto - not connected/);
  assert.match(rendered, /run \/provider setup to connect/);
});

test("FIX-18 (F3): a connected route never grows the not-connected state", () => {
  const rendered = text(frame({
    state: { ...state, resolvedModel: "", model: "openrouter/auto", routeNotConnected: false },
  }).lines);

  assert.match(rendered, /Route {5}openrouter\/auto/);
  assert.doesNotMatch(rendered, /not connected|\/provider setup/);
});

test("FIX-18 (F3): no route at all while unconnected names /provider setup, not /model", () => {
  const rendered = text(frame({
    state: { ...state, resolvedModel: "", model: "", routeNotConnected: true },
  }).lines);

  assert.match(rendered, /No provider connected - \/provider setup/);
  assert.doesNotMatch(rendered, /\/model picks one/);
});
