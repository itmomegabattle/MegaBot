# MegaBattle Mini App — redesign plan

## Direction

Turn the current generic blue card interface into a compact MegaBattle operations surface. The visual system is driven by official brand tokens, Druk/Raleway typography, the wave/ribbon motif, black-and-white contrast, and Phosphor icons.

## Audit findings

- Product logic and flows are already substantial and should stay intact.
- Visual decisions are spread across many one-off utility classes.
- Global `!important` overrides create inconsistent hierarchy and make dark mode fragile.
- Cards, controls, and states are visually too similar, slowing scanning.
- The current header imitates a logo in text instead of using the official asset.
- Touch targets and safe-area handling are uneven.
- Lucide usage is consistent enough to replace mechanically with one icon family.

## Implementation sequence

1. Establish semantic tokens for color, typography, spacing, radius, depth, motion, and z-index.
2. Self-host the approved Druk and Raleway files and use the official logo.
3. Rebuild the app shell: branded header, clear current-page context, safe-area-aware bottom navigation.
4. Standardize buttons, fields, segmented controls, cards, status treatments, tables, empty states, and focus styles.
5. Preserve dense content while clarifying groups and progressive disclosure.
6. Replace all Lucide icons with regular-weight Phosphor icons; use filled weight only for the active navigation state.
7. Normalize light/dark themes through semantic tokens.
8. Verify 375px mobile, wider mobile/tablet, landscape, keyboard focus, reduced motion, loading, disabled, error, and empty states.

## Non-goals

- No API, data model, permissions, copy, or workflow changes.
- No new marketing hero, gamification, decorative glassmorphism, or continuous animation.
- No visual references outside the two approved Figma areas and the supplied beta site.

## Acceptance criteria

- Existing TypeScript checks and production build pass.
- All existing tabs and actions remain present.
- No Lucide dependency or mixed icon family remains.
- Official logo and fonts render locally.
- Brand blue is `#0069E0`; components use semantic tokens instead of new ad-hoc hex values.
- Interactive targets are at least 44px, focus is visible, reduced motion is respected, and fixed UI respects Telegram safe areas.

## Reliability follow-up — 2026-08-03

The redesign now treats the Telegram chat as a stateful product surface, not a collection of disposable messages. Slot editing remains in one message, selection counts are explicit, whole-day selection is visible inside every day, and save produces a stable confirmation with actions to edit again or open the profile.

The next redesign pass should add visible `saving / synchronized / retrying` states to both chat and Mini App, validate Telegram username navigation on all supported clients, and visually align chat copy with Mini App terminology.

## Completed follow-up — 2026-08-09

The chat navigation contract is now consistent: back navigation stays in the reply keyboard and inline panels only contain contextual actions. Slot-day editing gained a snapshot-based cancel operation. The profile editor now collapses block selection by default and distinguishes memberships from the primary block. Avatar crop preview/export were consolidated onto one canvas path, eliminating coordinate drift.

Future design work includes the unimplemented task assignment choice `Каждому лично` versus `Одна задача на всех`, plus visible per-assignee progress (`N из M`) for personal assignments.
