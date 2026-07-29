---
name: MegaBattle Mini App
description: A dense Telegram operations surface in the official MegaBattle visual language.
colors:
  battle-blue: "#0069E0"
  battle-blue-hover: "#1677E8"
  battle-blue-active: "#0058BD"
  stage-black: "#000000"
  signal-white: "#FFFFFF"
  midnight-ink: "#061222"
  operational-muted: "#4D647A"
  secondary-muted: "#718293"
  arena-canvas: "#F3F6F8"
  ice-blue-surface: "#EAF2FB"
  control-gray: "#F4F7FA"
  logo-cyan: "#2685BB"
  dark-surface: "#0D1117"
  dark-surface-soft: "#101D2B"
  dark-control: "#151B23"
  dark-muted: "#C1CCD8"
  dark-subtle: "#8E9BAB"
  dark-link: "#65AAFF"
  success-green: "#059669"
  attention-amber: "#D97706"
  critical-rose: "#E11D48"
typography:
  display:
    fontFamily: "Druk Text Wide Cyr, Arial Black, sans-serif"
    fontSize: "clamp(15px, 4.3vw, 21px)"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "Druk Text Wide Cyr, Arial Black, sans-serif"
    fontSize: "24px"
    fontWeight: 500
    lineHeight: 1
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Raleway, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.5
  label:
    fontFamily: "Raleway, Segoe UI, sans-serif"
    fontSize: "12px"
    fontWeight: 900
    lineHeight: 1.25
  field:
    fontFamily: "Raleway, Segoe UI, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.5
rounded:
  control: "14px"
  card: "20px"
  gate: "24px"
  pill: "999px"
spacing:
  hairline: "4px"
  compact: "8px"
  field: "12px"
  card: "16px"
  section: "24px"
components:
  button-primary:
    backgroundColor: "{colors.battle-blue}"
    textColor: "{colors.signal-white}"
    typography: "{typography.body}"
    rounded: "{rounded.card}"
    padding: "12px 20px"
    height: "44px"
    fontWeight: 900
  button-primary-hover:
    backgroundColor: "{colors.battle-blue-hover}"
    textColor: "{colors.signal-white}"
  button-primary-active:
    backgroundColor: "{colors.battle-blue-active}"
    textColor: "{colors.signal-white}"
  button-secondary:
    backgroundColor: "{colors.ice-blue-surface}"
    textColor: "{colors.battle-blue}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "8px 12px"
    height: "44px"
  field:
    backgroundColor: "{colors.control-gray}"
    textColor: "{colors.midnight-ink}"
    typography: "{typography.field}"
    rounded: "{rounded.control}"
    padding: "12px"
    height: "44px"
  card:
    backgroundColor: "{colors.signal-white}"
    textColor: "{colors.midnight-ink}"
    rounded: "{rounded.card}"
    padding: "16px"
  chip:
    backgroundColor: "{colors.ice-blue-surface}"
    textColor: "{colors.battle-blue}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "4px 10px"
  nav-item-active:
    backgroundColor: "{colors.battle-blue}"
    textColor: "{colors.signal-white}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    height: "48px"
    heightWide: "56px"
---

# Design System: MegaBattle Mini App

## Overview

**Creative North Star: "The Live Control Deck"**

MegaBattle Mini App feels like the compact control surface behind a live event: energetic, immediate, and operationally precise. Official identity leads every screen through a black stage header, Battle Blue actions, the white MegaBattle mark, Druk display type, and the blue ribbon-like field that crosses the canvas. Raleway carries dense working information without turning the app into a marketing page.

The interface is mobile-first and intentionally dense. Status, ownership, and the next action stay visible; details expand in place. Bright blue is reserved for active navigation, primary actions, selected time slots, links, and focus. Most working surfaces remain white or near-white so repeated use stays calm.

The direction was explicitly user-approved and pinned to supplied official brand sources. No concept roll or seed key was run; this is a FORM exemption, not an unresolved design choice. Exact Figma ribbon/star exports and full-tab post-fix screenshots remain verification gaps, not missing design tokens.

**Key Characteristics:**

- Official MegaBattle logo and typography anchor the interface.
- Black stage chrome, Battle Blue action states, and pale operational surfaces create the hierarchy.
- Compact cards and progressive disclosure support repeated Telegram use.
- Phosphor icons use regular weight at rest and fill for active navigation.
- Motion is state-led, short, and fully reduced when the system requests it.

## Colors

The palette combines a saturated institutional blue with stage black, clear white, cool operational neutrals, and narrowly scoped semantic status colors.

### Primary

- **Battle Blue** (#0069E0): primary actions, active navigation, selected slots, links, focus, and the header rule.
- **Battle Blue Hover** (#1677E8): pointer hover for primary controls.
- **Battle Blue Active** (#0058BD): pressed state for primary controls.

### Secondary

- **Logo Cyan** (#2685BB): the cyan disc embedded in the official logo; preserve it as part of the identity asset.

### Neutral

- **Stage Black** (#000000): fixed header, gates, and dark-theme canvas.
- **Signal White** (#FFFFFF): card surfaces, logo strokes, and text on blue or black.
- **Midnight Ink** (#061222): primary text in the light theme.
- **Operational Muted** (#4D647A): secondary copy and metadata.
- **Secondary Muted** (#718293): placeholders and low-emphasis labels.
- **Arena Canvas** (#F3F6F8): light-theme page background.
- **Ice Blue Surface** (#EAF2FB): selected-adjacent and secondary action surfaces.
- **Control Gray** (#F4F7FA): input, table-header, and quiet control backgrounds.
- **Success Green** (#059669), **Attention Amber** (#D97706), and **Critical Rose** (#E11D48): result, unsaved/warning, and destructive/error states only.

**The Blue Means Action Rule.** Battle Blue signals interaction or current state; it is not a general card fill.

**The Semantic Isolation Rule.** Green, amber, and rose communicate status only and never replace brand color in navigation or ordinary actions.

## Typography

**Display Font:** Druk Text Wide Cyr (with Arial Black fallback)

**Body Font:** Raleway (with Segoe UI fallback)

**Character:** Druk gives headers the compressed, event-scale force of the official identity. Raleway keeps controls, metadata, schedules, and long operational forms readable.

### Hierarchy

- **Display** (500, fluid 15–21px, 1 line-height): sticky page title; uppercase, tightly tracked, and always kept on one line.
- **Headline** (500, 24px, 1 line-height): gate and exceptional state headings.
- **Title** (500, 16px, 1.05 line-height): section headings inside the working surface.
- **Body** (600, 14px, 1.5 line-height): descriptions, rows, and field values.
- **Label** (900, 12px, 1.25 line-height): buttons, field labels, chips, status, and compact navigation copy.

**The Two-Voice Rule.** Druk is for hierarchy and identity; Raleway handles every interactive or information-dense detail.

**The Numeric Scan Rule.** Lining and tabular numerals stay enabled for hours, dates, counts, and schedules.

## Layout

The shell is a single mobile column capped at 768px. Mobile gutters are 16px and become 24px from 640px upward. Cards use 16px internal padding; fields and compact groups use a 12px or 8px rhythm. Major workflow groups are separated by 16px, with 24px reserved for larger section boundaries.

The header stays at the top and the five-item navigation stays fixed above Telegram's bottom safe area. Main content reserves the navigation footprint. Forms, task details, availability days, and people lists disclose in place instead of opening decorative dashboards. At very small widths the logo and display title compress; short landscape layouts reduce header height.

**The First Action Rule.** The current workflow and its next action appear immediately after the compact header; there is no promotional hero inside the product.

## Elevation & Depth

The system uses a restrained hybrid of tonal layering and ambient elevation. White cards sit above the cool canvas with a soft `0 14px 34px rgba(6, 18, 34, 0.08)` shadow. The black header uses a stronger downward shadow, while active blue controls receive a narrow blue-tinted lift. Inputs rely primarily on tonal contrast and an inset highlight; focus adds a blue halo.

### Shadow Vocabulary

- **Card Ambient** (`0 14px 34px rgba(6, 18, 34, 0.08)`): standard workflow cards and forms.
- **Raised Gate** (`0 18px 44px rgba(0, 0, 0, 0.14)`): access and registration panels.
- **Header Stage** (`0 12px 32px rgba(0, 0, 0, 0.24)`): separates persistent black chrome from content.
- **Active Blue** (`0 10px 24px rgba(0, 105, 224, 0.20)`): selected navigation and compact primary actions.

**The Flat-Until-Important Rule.** Tonal layering establishes ordinary structure; stronger shadows are reserved for persistent chrome, gates, and active controls.

## Shapes

Working cards use gently rounded 20px corners. Fields, selected navigation items, and nested containers use 14px corners. Compact actions and metadata chips are fully pill-shaped. The 24px gate radius is reserved for standalone access panels. Borders are cool, low-contrast lines; dashed borders identify empty states.

The ribbon-like canvas field and cyan logo disc are the only recurring organic geometry. Do not introduce unrelated blobs or ornamental card silhouettes.

## Components

### Buttons

- **Shape:** full-width primary actions use the 20px card radius; compact secondary actions use pills.
- **Primary:** Battle Blue with Signal White text, minimum 44px height, and 12px × 20px padding.
- **Hover / Focus / Active:** lighter blue on hover, deeper blue on press, a visible blue focus outline, and a restrained 0.98 press scale.
- **Secondary / Ghost:** pale ice-blue or transparent surface, Battle Blue label, thin cool border, and 44px touch target.

### Chips

- **Style:** pale ice-blue with Battle Blue text for competency and selected metadata; cool gray for neutral metadata.
- **State:** chips summarize status or filtering context and do not impersonate large primary actions.

### Cards / Containers

- **Corner Style:** gently rounded (20px).
- **Background:** white in light mode and deep graphite in dark mode.
- **Shadow Strategy:** ambient card shadow on top-level workflow cards; nested containers use tonal separation without additional lift.
- **Border:** one cool low-contrast line.
- **Internal Padding:** 16px, reduced to 12px for nested groups.

### Inputs / Fields

- **Style:** 44px minimum height, cool gray background, 14px radius, 12px padding, and semibold Raleway.
- **Focus:** white surface, Battle Blue border, and a translucent 4px blue halo.
- **Error / Disabled:** rose field treatment for errors; disabled controls reduce opacity and saturation while keeping labels legible.

### Navigation

The five-item bottom navigation is fixed, safe-area aware, and translucent over the page. Each item is 48px high on phones and 56px from 640px upward, with a Phosphor icon over a compact label. Active state uses Battle Blue, white copy, and a filled icon; inactive state is transparent with muted copy and a regular-weight icon.

### Progressive Disclosure

Potentially long collections show the first three items by default. The expand/collapse control appears before the collection, so a user never has to scroll to the bottom to close it. Search temporarily reveals all matching people. This pattern applies to participants, assignees, meetings, tasks, competencies, faculty groups, and unavailable-user lists.

### Participant Profile

The participant identity in the sticky header is the profile entry point. The initial profile is an intentional empty state and does not add a sixth bottom-navigation item.

### Availability Slot

Each hour is a 44px compact control. Selected time uses Battle Blue, white text, and a blue ambient shadow; unselected time uses Control Gray and muted text. Day cards group the slots and expose whole-day selection without changing the schedule model.

## Do's and Don'ts

### Do:

- **Do** use the official logo, Druk/Raleway pairing, and Battle Blue as the first source of visual truth.
- **Do** keep touch targets at least 44px and preserve Telegram safe areas.
- **Do** use compact lists, cards, chips, and in-place disclosure for dense operational work.
- **Do** use Phosphor icons consistently: regular at rest, fill for active navigation.
- **Do** keep state transitions around 150–200ms and honor `prefers-reduced-motion`.

### Don't:

- **Don't** turn every surface blue or use brand color as generic decoration.
- **Don't** add childish illustration, claymorphism, unrelated gradients, or template-dashboard chrome.
- **Don't** use Druk for body copy, field values, or long descriptions.
- **Don't** mix icon families or replace clear text actions with ambiguous icon-only controls.
- **Don't** treat unverified ribbon/star exports as permission to invent new brand assets.
