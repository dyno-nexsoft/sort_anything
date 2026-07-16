# Change Log

All notable changes to the "Dyno Extension" extension will be documented in this file.

## [0.2.3] - 2026-07-16
- Enhanced **Claude Task Monitor** UI/UX layout:
  - Increased the right sidebar width from `320px` to `380px` to give more horizontal space for tool progress bars and activity details.
  - Compacted the Activity feed time column font size (`11px`) and width (`68px`) to prevent ugly wrapping.
  - Implemented collapsible prompt turns in the Activity feed with state preservation (manually expanded/collapsed turns are remembered across renders).
  - Added thin custom styled scrollbars utilizing VS Code theme scrollbar colors.
  - Adjusted responsive grid wrap breakpoint from `780px` to `900px`.

## [0.2.2] - 2026-07-16
- Redesigned UI/UX of **Claude Task Monitor**:
  - Grouped **Activity feed** by user prompt/turn into collapsible blocks with a timeline stem line on the left.
  - Extracted and stored actual user prompt text to display as a preview on the turn headers and timeline vertical bar tooltips.
  - Added a **Cache Hit Rate progress bar** inside the Cost card to visualize Claude's Prompt Caching efficiency (cached vs non-cached ratio).
  - Cleaned up layout, spacing, and styling of the overview grid.

## [0.2.1] - 2026-07-16
- Improved **Claude Task Monitor** UI layout & compactness:
  - Repositioned **Cost & tokens**, **Models & agents**, and **Overview** to the top in a responsive grid.
  - Redesigned **Overview** as a vertical stat card matching the layout of the **Cost** card.
  - Fixed **Tool usage** horizontal bar chart overlapping bug by using responsive flex percentages.
  - Fixed time column formatting in **Activity feed** to prevent ugly wrapping.

## [0.2.0] - 2026-07-16
- Added **Claude Task Monitor** featuring:
  - Hub-and-spoke agent orchestration diagram showing the main model and spawned subagents.
  - Live status tracking with color-coding (running = pulsing blue, done = green, failed = red).
  - Cost and token counters estimating usage per model (Sonnet, Haiku, Opus).
  - Interactive file list showing changed/created/deleted files with status badges (M/A/D/?).
  - Session picker to browse previous transcript files.
  - Setup commands to install/remove live webhooks in `.claude/settings.json`.
  - Keyboard shortcut (`Ctrl+Alt+M` / `Cmd+Alt+M`) and dedicated SCM and editor title menu entries.

## [0.1.0] - 2026-07-09
- Added **AI Commit Message Generator** featuring:
  - Stable `scm/title` menu integration (✨ sparkle icon on SCM title bar).
  - Dynamic Gemini model selection from Google API (defaults to `gemini-3.5-flash`).
  - Dynamic local/remote Ollama model selection via `/api/tags` endpoint.
  - Natural, concise commit messages (auto-formatted single-line for simple changes, bullet points for complex ones).
  - Integrated dedicated Output Channel logging for easy troubleshooting and log retrieval.
  - Full support for Remote SSH, WSL, and Dev Containers.

## [0.0.5] - [0.0.8]
- Added **Dart Barrel File Generator** via Explorer right-click context menu.
- Barrel file is named `<folder_name>.dart`, sorted, and overwrites existing file without a generated header comment.
- Extracted release notes from README into a dedicated CHANGELOG.md file.

## [0.0.4]
- Fixed JSONC comment preservation using `comment-json` library.
- Fixed `.env` multiline value handling.
- Fixed trailing blank lines being sorted to the top in plain text files.
- Added status bar feedback messages.

## [0.0.1] - [0.0.3]
- Initial release with JSON, YAML, .env, .properties, and Plain Text sorting.
- Added Right-Click context menu support.
