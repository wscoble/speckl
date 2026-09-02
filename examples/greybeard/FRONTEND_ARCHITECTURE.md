# Greybeard SPoT — Frontend Component Architecture

Derived from Basecamp power-user behaviors. Each component is a self-contained
unit that can be built by a separate agent. Components compose into the full UI.

## Spec → Component Mapping

| SpeckDL Spec | Go Package | UI Components |
|---|---|---|
| Project | `project` | ProjectSwitcher, ProjectHeader |
| CardTable | `card_table` | Board, Column, Card, CardDetail, MoveMenu, ApprovalBadge |
| Campfire | `campfire` | CampfireThread, AlertBanner, MessageInput |
| MessageBoard | `message_board` | MessageList, MessageView, MessageComposer, CommentThread |
| Dashboard | `dashboard` | DashboardGrid, MyCardsPanel, AwaitingApprovalPanel, OverduePanel |

## Components (one agent per component)

### 1. `Board` — the Kanban surface
- Renders all 8 columns with cards
- Column collapse/expand (click header, keyboard, localStorage persistence)
- Empty columns auto-collapse; drop on collapsed column expands it
- Card count badges on column headers
- `props`: `columns: ColumnView[]`, `onMove: (cardId, target) => void`
- `emits`: `move`, `select-card`
- **API**: reads from `GET /state.json`, htmx swaps from `POST /actions/move_card`

### 2. `Card` — a single card
- Title, description, assignee avatar, due date indicator
- Contextual action buttons based on column:
  - FiguringItOut → "Request approval"
  - ApprovalRequested → "Approve" + "Deny"
  - Approved → "Execute"
  - InProgress → "Complete"
  - All columns → "Move…" popover
- Draggable (HTML5 DnD) with keyboard fallback
- Comment count badge
- `props`: `card: CardView`, `comments: CommentView[]`
- **Interactions**: drag-drop, click buttons, keyboard nav (tab to actions)

### 3. `MoveMenu` — popover for moving cards (replaces select boxes)
- Opens on "Move…" button click or keyboard activation
- Lists all valid target columns (excluding current)
- Highlights current column
- Closes on: selection, Escape, outside click
- `props`: `cardId: number`, `currentColumn: string`, `onSelect: (target) => void`
- **A11y**: `role="menu"`, `role="menuitem"`, arrow key navigation

### 4. `CardDetail` — expanded card view (modal or inline)
- Full title, description, all comments, move history
- Comment composer
- Assignment picker, due date picker
- `props`: `cardId: number`
- **API**: reads from `GET /state.json`, comments from the same

### 5. `CampfireThread` — chat/alerts panel
- Scrollable list of messages (newest first)
- Three message types: human (white), system (dimmed), alert (colored)
- Input box at bottom for posting new messages
- Auto-scroll to bottom on new message
- `props`: `projectId: string`
- **API**: reads from campfire state, posts via `POST /actions/post_message`

### 6. `MessageBoard` — weekly logs and announcements
- List of messages with subject, author, date, kind badge
- Click to expand full message with comments
- "Post weekly log" button (admin only)
- Message kind badges: weekly-log, announcement, report
- `props`: `projectId: string`
- **API**: reads from message_board state

### 7. `DashboardGrid` — power-user overview
- Four panels: My Cards, Awaiting Approval, Overdue, Recently Completed
- Each panel is a compact list of card titles with column indicators
- Click a card to jump to it on the board
- Overdue cards highlighted in red
- `props`: `person: string`
- **API**: derived queries against card_table state

### 8. `ProjectSwitcher` — multi-client workspace nav
- Dropdown/slide-out listing all projects
- Shows project name, card count, alert count
- Active project highlighted
- "New project" button
- `props`: `projects: Project[]`, `activeProject: string`
- **API**: reads from project state

### 9. `AddCardModal` — creation dialog
- Title input (required), description textarea
- Assignee picker (optional)
- Due date picker (optional)
- Focus trap, Escape closes, focus restoration
- `props`: `nextCardId: number`, `projectId: string`
- **API**: `POST /actions/create_card`

### 10. `SearchBar` — global search
- Text input, searches cards and messages
- Results dropdown grouped by type (cards, messages, comments)
- Keyboard shortcut: `/` to focus
- `props`: `onSelect: (result) => void`
- **API**: client-side search against `GET /state.json`

## Composition

```
App
├── ProjectSwitcher (sidebar / header)
├── DashboardGrid (top-level tab)
├── Board (main content — kanban)
│   ├── Column × 8
│   │   ├── Card × N
│   │   │   ├── ApprovalBadge (conditional)
│   │   │   ├── MoveMenu (popover)
│   │   │   └── CommentThread (inline)
│   │   └── AddCardModal trigger (Triage only)
│   └── SearchBar (overlay)
├── CampfireThread (sidebar / bottom panel)
├── MessageBoard (tab)
└── CardDetail (modal overlay)
```

## Shared Design System

```
Colors (dark mode):
  --bg: #141821         background
  --surface: #1c212c    card/column background
  --surface2: #242a38   hover/elevated surface
  --surface3: #2d3446   popover/active
  --border: #333c50     subtle borders
  --text: #cdd3e0       body text
  --text-hi: #f0f2f8    headings
  --text-dim: #7a8296   metadata
  --red: #e5484d        accent / denied
  --green: #30a46c      approved / success
  --blue: #5b9bd5       links / focus
  --cyan: #00a2c7       in-progress
  --purple: #9d7cd8      done
  --yellow: #f5d90a      figuring-out
  --orange: #f76b15     approval-requested

Typography:
  Inter (Google Fonts)
  - 14px body, 600 weight card titles
  - 12px uppercase column headers, 700 weight
  - 17px page title, 700 weight

Spacing:
  - 4px base unit
  - Card padding: 12px 14px
  - Column gap: 12px
  - Board padding: 20px 24px

Touch targets:
  - Minimum 44px height for all interactive elements
  - 44px minimum for drag handles

Focus:
  - :focus-visible with 2px solid --blue outline
  - Focus trap in modals
  - Skip navigation link
```

## Agent Instructions

Each agent builds ONE component. The component must:
1. Import the design system (CSS custom properties above)
2. Use htmx for server communication (no fetch/XHR directly)
3. Be accessible (ARIA, keyboard, touch targets)
4. Work standalone (can be tested in isolation)
5. Use the Go backend API surface defined in the specs

Agents should reference the compiled Go packages for API shapes:
- `test-output/greybeard/card_table/` — Card, Move, Comment types
- `test-output/greybeard/campfire/` — CampfireMessage types
- `test-output/greybeard/message_board/` — BoardMessage types
- `test-output/greybeard/project/` — ProjectRecord, Person types