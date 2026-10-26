# NetSense UI design

The dashboard is an operations console: someone looks at it to answer "is the
network as it should be, and if not, what changed?". Every rule below serves
that: show more data, with less decoration, and make the important things
(something down, something changed) stand out because nothing else does.

## Principles

1. **Data first.** Tables, key-value grids and lists, densely packed. No
   explanatory paragraphs on screen; a short label, and a tooltip where an
   explanation really helps.
2. **Colour means something.** Green is up/OK, red is down/critical, amber is
   a warning, grey is unknown, and the one accent colour marks what can be
   clicked or is selected. Nothing is coloured for decoration.
3. **Flat structure.** One level of sections separated by 1px lines. No
   cards inside cards, no floating panels on the page.
4. **Technical values in mono.** IP and MAC addresses, interface names, VLAN
   IDs, commands and configuration are set in IBM Plex Mono, so they line up
   and characters like `0`/`O` and `1`/`l` cannot be confused.
5. **Quiet until something is wrong.** A healthy network should look calm: a
   few green dots. Problems use the strong colours, so they are found at a
   glance.

## Tokens

All colours are CSS variables on `<html>`, switched by `data-theme="dark"`
(the default) or `"light"`. Tailwind utilities read them by name
(`bg-canvas`, `text-fg-muted`, `border-line`, `text-crit` ...), so a component
never names a raw colour and works in both themes.

### Colour

| Token | Use | Dark | Light |
|---|---|---|---|
| `canvas` | page background | `#0e1116` | `#f5f6f8` |
| `surface` | sidebar, top bar, table headers, panels | `#151a21` | `#ffffff` |
| `raised` | hover rows, inputs, menus | `#1c232c` | `#eef1f4` |
| `line` | 1px dividers and table borders | `#252c36` | `#dde2e7` |
| `line-strong` | input borders, focus outlines' base | `#343d49` | `#c4cbd3` |
| `fg` | primary text | `#d6dce3` | `#1b2027` |
| `fg-muted` | secondary text, labels | `#8a95a3` | `#59626d` |
| `fg-subtle` | placeholders, disabled, axis text | `#5e6875` | `#8b949e` |
| `accent` | links, selected item, primary button, focus | `#4b93f2` | `#1f6feb` |
| `ok` | up, healthy, forwarding, success | `#3fb950` | `#1a7f37` |
| `warn` | warning, degraded, converging | `#d29922` | `#9a6700` |
| `crit` | down, critical, failed, blocked | `#f0524a` | `#cf222e` |
| `unknown` | unknown, not collected, info | `#6e7781` | `#6e7781` |

Each status colour also has a `-soft` variant (the colour at about 12%
opacity) for the rare tinted background, such as a selected severity filter.

### Typography

| Role | Font | Size / line height | Weight |
|---|---|---|---|
| Body, table cells | IBM Plex Sans | 13px / 20px | 400 |
| Labels, column headers | IBM Plex Sans | 11px / 16px, uppercase, +0.04em tracking | 500 |
| Section title | IBM Plex Sans | 13px / 20px | 600 |
| Page title | IBM Plex Sans | 15px / 22px | 600 |
| KPI value | IBM Plex Sans, tabular figures | 20px / 26px | 500 |
| Technical values | IBM Plex Mono | 12px / 20px | 400 |

The fonts are bundled with the dashboard (`@fontsource`), not loaded from a
font service, so it works on a Raspberry Pi without internet access.
Numbers in tables use tabular figures so columns line up.

### Space, shape, depth

- **Spacing:** a 4px grid. 4, 8, 12, 16, 24. Page padding is 16px; table
  cells are 6px by 12px.
- **Row height:** 36px for table rows; 44px for the top bar.
- **Radius:** 4px for inputs, buttons, menus and the side panel; 2px for small
  chips; dots are round. Sections themselves have no radius.
- **Shadows:** none, except on things that float above the page (menus, the
  mobile navigation drawer, the topology side panel):
  `0 8px 24px rgb(0 0 0 / 0.35)` in dark, `/ 0.12` in light.
- **Borders:** 1px `line` everywhere.

## Layout

```
+----------+-------------------------------------------------------------+
| NetSense | Last scan 12 min ago | Baseline Oct 9 · 0 critical    o API  admin v |  <- top bar, 44px
|          +-------------------------------------------------------------+
| Overview |  (slim message bar, only when something needs attention)    |
| Topology +-------------------------------------------------------------+
| Devices  |                                                             |
| Scans    |  page content, full width, sections divided by 1px lines    |
| Collect. |                                                             |
| Health   |                                                             |
+----------+-------------------------------------------------------------+
  208px
```

- **Sidebar:** 208px, `surface` background. Items are 32px high with a 16px
  icon. The current page has an accent bar on its left edge and `fg` text;
  others are `fg-muted`. Below 768px wide the sidebar becomes a drawer opened
  from a menu button in the top bar.
- **Top bar:** network status on the left (last scan, baseline status), the
  current activity (a running scan or collection), API status, theme toggle
  and user menu on the right.
- **Content:** full width with 16px padding. A page is a title row and a
  stack of sections; a section is a title bar and its content, with 1px lines
  between sections.

## Components

- **Status dot:** an 8px dot in the status colour followed by the text
  ("Up", "Down", "Not seen"). Text always accompanies the colour, for
  colour-blind readers and for print.
- **Table:** 36px rows, header row sticky with `surface` background and
  uppercase labels, sortable columns show a small arrow, numbers and counts
  right-aligned with tabular figures, row hover in `raised`. No zebra stripes.
- **Key-value grid:** label in `fg-muted` small caps on the left, value on the
  right; two or three columns of pairs on wide screens.
- **Message bar:** one line, 32px, a 3px coloured left border (`crit`, `warn`,
  `accent` for information), short text and at most one action. Replaces large
  alert boxes.
- **Drift findings:** incident list. Each finding has a 3px left border in its
  severity colour. A probable cause is shown with its effects indented below
  it, joined by a thin tree line.
- **Faceplate** (`Faceplate.tsx`, data from `faceplate.ts`): a router's or
  switch's front panel, one jack per physical port grouped by slot. The jack
  is coloured by state (up `ok`, down `crit`, admin down dashed and empty)
  and labelled with the access VLAN, `T` (trunk) or `L3` (routed); the LED
  above it turns `warn` when spanning tree blocks the port. Hover or focus
  shows VLANs, CDP neighbour, MAC (or ARP) count, STP and OSPF state. The
  legend lists only the markings the panel uses. Subinterfaces make their
  parent a trunk; SVIs and loopbacks are listed as chips under the panel.
- **Config and diff view** (`CodeView.tsx`, highlighting in `ios.ts`): line
  numbers, IOS syntax colours (`code-keyword`, `code-interface`,
  `code-address`, `code-number`, `code-string`; comments `fg-subtle`, `no`
  and `shutdown` `crit`), unified or side by side. These five tokens are the
  only colours outside the status palette, and only inside code.
- **Buttons:** 28px high. Primary is `accent` filled, secondary is outlined in
  `line-strong`; destructive actions do not exist in NetSense.
- **Loading:** skeleton rows the height of real rows, not spinners in the
  middle of empty space. A spinner only for something running in the
  background (a scan).
- **Empty states:** one short line saying what is missing and, when there is
  one, the action that fills it ("No collections yet. Collect from all
  devices").

## Brand

- **Mark:** an "N" drawn as a network path: four nodes, three links, on an
  accent tile with 7/32 corner radius. The top-right node has a faint ring,
  the "sense". Files: `frontend/src/components/Logo.tsx`,
  `frontend/public/favicon.svg`.
- **Wordmark:** "Net" in `fg`, "Sense" in `accent`, IBM Plex Sans 600, -0.01em.
- **Login:** the only page with a decorative background: a faint, seeded
  network graph (`NetworkBackdrop.tsx`) that fades out behind the form.

## Motion

Subtle and functional only: 150 ms colour transitions on hover; a slow pulse
on things that are live (a running scan's dot, login backdrop hubs); slowly
moving dashes on healthy topology links. Everything that moves stops under
`prefers-reduced-motion`.

## Copy

- Labels, not sentences. "Last scan", not "This is when the last scan ran".
- Explanations go in tooltips (`title`) or the docs, not on the page.
- Times are relative ("12 min ago") with the exact local timestamp on hover.
- Findings and errors are full sentences, because they are read once and must
  be acted on.
