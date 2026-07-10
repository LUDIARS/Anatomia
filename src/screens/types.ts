/**
 * src/screens/types.ts — Screen-composition model (types only).
 *
 * A "screen" is a unit of UI the user navigates between: a routed web page, a
 * view component, or a game UI panel/dialog/scene. Anatomia learns the screen
 * composition — which screens exist, what each one contains (child screens), and
 * which screens it navigates to — as a static, deterministic overlay on the call
 * graph, the same way patterns/ detects access patterns.
 *
 * This is the structural ("画面構成") discovery counterpart to scenes/. Screens
 * are static composition, while trace-derived scenes are runtime phases, but the
 * user-facing layer projects both to SceneRef so the panel treats screens,
 * runtime phases, and cross-screen workflows/modules as scenes.
 *
 * SRP: type definitions only. Detection lives in detect.ts.
 */

/** The technology stack a screen belongs to (drives the detection heuristics). */
export type ScreenStack = "web" | "unity" | "native";

/**
 * What kind of screen this is. Derived from the declaring name's suffix, the
 * directory convention, or the routing/scene mechanism it is bound through.
 */
export type ScreenKind =
  | "page" // a routed top-level page (web route / Next page)
  | "view" // a view-level component (`*View` / `*Screen`)
  | "panel" // a UI panel (game/Unity `*Panel`)
  | "dialog" // a modal / dialog / window (`*Dialog` / `*Modal` / `*Window`)
  | "menu" // a menu screen (`*Menu`)
  | "hud" // a HUD / overlay (`*HUD` / `*Overlay`)
  | "scene"; // a Unity/game scene referenced via LoadScene

/** One detected screen + its composition (contains) and navigation (navigatesTo). */
export interface ScreenNode {
  /**
   * Stable identity: the declaring component/class name, or — for a scene with no
   * declaring file — the scene name referenced via LoadScene.
   */
  name: string;
  /** Repo-relative, forward-slashed path of the declaring file. "" for scene-only. */
  file: string;
  /** 1-indexed declaration line (0 for scene-only screens). */
  line: number;
  kind: ScreenKind;
  stack: ScreenStack;
  /** URL path (routing table / Next file route) or scene name, when known. */
  route?: string;
  /** Names of OTHER detected screens this screen composes (child screens). */
  contains: string[];
  /**
   * Screen names (resolved) or raw paths (unresolved) this screen navigates to,
   * via navigate()/router.push()/<Link to>/redirect()/LoadScene().
   */
  navigatesTo: string[];
  /** Why it was detected (heuristic that fired). */
  reason: string;
  /** Domains whose functions live in this screen's file (call-graph attribution). */
  domains: string[];
}

/** The whole screen composition for a repo. */
export interface ScreenGraph {
  screens: ScreenNode[];
  summary: {
    total: number;
    byStack: Record<string, number>;
    byKind: Record<string, number>;
    /** Total composition + navigation edges (sum of contains + navigatesTo). */
    edges: number;
  };
}
