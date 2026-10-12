// The app shell has one fixed dark palette. Its dedicated asset deliberately
// has no prefers-color-scheme media query: an external SVG can otherwise
// repaint to its light variant independently of the already-dark WebView.
import routeCoreIconUrl from "./assets/route-core-dark.svg?url&no-inline";

import { el } from "./dom.js";

export type RouteCoreBrandPlace = "empty" | "chat-header" | "settings-header";

export function routeCoreBrand(place: RouteCoreBrandPlace): HTMLElement {
  return el("div", { class: `route-core-brand route-core-brand--${place}` }, [
    el("img", {
      src: routeCoreIconUrl,
      alt: "ORCODE Route Core",
      "data-brand": "route-core",
      draggable: "false",
    }),
  ]);
}
