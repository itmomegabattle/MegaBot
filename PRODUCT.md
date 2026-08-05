# MegaBattle Mini App

## What it is

MegaBattle Mini App is an operational workspace inside Telegram for the MegaBattle organizing team. It turns the bot's team data into a compact mobile interface for coordinating availability, meetings, tasks, people, and faculty work.

## Users and roles

- **Admin** — manages the whole team, meetings, tasks, competencies, faculty workflows, and exports.
- **Organizer** — shares availability, joins team coordination, and works with assigned/open tasks.
- **Faculty responsible / helper** — participates in faculty-specific task workflows, primarily through the bot and the faculty section.

Role boundaries are enforced by existing application logic and must not be changed by visual work.

## Core jobs

1. Mark and save personal availability for upcoming weeks.
2. See team availability and find viable meeting windows.
3. Schedule, inspect, edit, and remove meetings.
4. Create, claim, complete, release, and inspect tasks.
5. Manage the organizing team and competencies.
6. Coordinate faculty representatives and faculty tasks.

## Product principles

- Preserve all existing functions, real Russian copy, permissions, and user journeys.
- Optimize for quick, repeated use on a phone inside Telegram.
- Make status, next action, and ownership easy to scan.
- Prefer compact lists and progressive disclosure over decorative dashboards.
- Every async action needs visible progress and a clear result.

## Brand truth

Brand materials have absolute priority over generic skill recommendations.

- Primary: `#0069E0`
- Neutral: `#000000`, `#FFFFFF`
- Supporting brand colors: `#2685BB`, `#BB2626`, `#60309C`, `#9D005F`
- Display type: Druk Text Wide Cyr
- Interface/body type: Raleway
- Recognizable assets: official MegaBattle logo, wave/ribbon system, soft star
- Visual tone: energetic, institutional, precise, contemporary; never childish or template-like

Sources currently approved:

- Figma file “Megabattle 2025–2026”, restricted to “Элементы” and “Гала-концерт весна 2026”
- Beta site `/faculties`

## Design dials

- `DESIGN_VARIANCE=4`
- `MOTION_INTENSITY=4`
- `VISUAL_DENSITY=7`

Interpretation: balanced composition, restrained state-led motion, and a dense operational layout.

## Open decisions

- Exact exported frames from the two approved Figma sections are still needed for pixel-level final brand verification because the Figma Starter MCP read limit was reached.
- The default theme can be revisited after real-device testing; the implementation keeps both light and dark modes.

## Current implementation update — 2026-08-03

Availability in Telegram chat is a single-message workflow: choose an active day, toggle hours, a whole day, or the whole configured week, return, save, and reopen the same values later. Day buttons expose exact dynamic counts. Administrators control the active weekdays, hour range and two-to-five-week horizon; the current default is Monday–Friday, 17:00–23:00. Drafts survive a process restart, stale and duplicate buttons are rejected, rapid taps are serialized, and failed message edits recover into one replacement panel.

The production Mini App uses `https://megaorgiabot.ru`; temporary tunnel hosts are rejected. Telegram usernames open through the Mini App API so supported clients keep the application alive while showing a teammate’s chat.

Next product work: show synchronization state to users, add retry/error feedback, collect completion telemetry, and run repeatable real-device checks on Telegram Desktop, Android and iOS.

Google Sheets uses one stable operational tab, `ОСНОВА`, addressed by its permanent sheet ID. Weekly rotation backs it up before changing dates or clearing slot values, restores native checkboxes, and preserves older generated week tabs as hidden recovery data instead of creating more tabs.

Tasks use one page-level active-event selector shared by personal, open, completed, and backlog views. Creation inherits that event and supports multiple executor blocks. The database workbook exposes a readable `task_log` sheet, while profiles support locally cropped and compressed avatars.

Tasks are now scoped by simultaneous work events. Administrators create and finish events without deleting their history; ordinary and faculty task forms attach an event, and My/Open/Completed/Backlog views filter independently by event. Task assignment supports search by name, Telegram username and competency. Meeting duration is validated from 30 minutes through 6 hours.
