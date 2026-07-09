<div align="center">
  <img src="icon.png" width="128" height="128" alt="Sort Anything Icon" />
  <h1>Sort Anything</h1>
  <p>A powerful VS Code extension to sort data files, generate Dart barrel files, and craft AI-powered commit messages.</p>
</div>

## Features

### 🔤 Sort Files
- **Sort Document**: Sorts all keys in the current file alphabetically.
- **Sort Selection**: Sorts only the keys within your highlighted selection.
- **Context Menu**: Quick access to sorting directly from the Right-Click menu inside the editor.
- **Comment-safe**: Preserves comments in YAML and JSONC files.
- **Recursive sorting**: Deeply sorts nested objects in JSON and YAML files.
- **ENV block sorting**: Sorts `.env` / `.properties` files while keeping `#` comments attached to their keys.
- **Line Sorting**: Sorts plain text files line-by-line.

### ✨ AI Commit Message Generator
- **One-click generation** from the Source Control commit input box.
- **Choose your AI provider** via a dropdown menu — similar to GitLens:
  - `✨ Generate Commit Message with Gemini` — uses Google Gemini API (cloud)
  - `🤖 Generate Commit Message with Ollama` — uses a local Ollama model (private, no API key)
  - `⚙️ Switch AI Provider / Configure...` — opens Settings
- Generates messages following **Conventional Commits** format (`feat:`, `fix:`, `chore:`, etc.)
- Reads only your **staged changes** (`git diff --staged`) — unstaged files are never sent.
- Lets you **review and edit** the message before it is applied.
- Automatically fills the message into the **Git SCM input box**.

### 🎯 Dart Barrel File Generator
- **Right-click any folder** in the Explorer → **"Generate Dart Barrel File"**
- Recursively scans all `.dart` files in the folder and sub-folders.
- Automatically skips `part of` files (they cannot be independently exported).
- Generates a `<folder_name>.dart` barrel file with sorted `export` statements.
- Overwrites the existing barrel file to keep it in sync with the folder.

---

## Supported Formats

| Format | Feature |
|---|---|
| `JSON` / `JSONC` | Sort keys, preserve comments |
| `YAML` | Sort keys, preserve comments & structure |
| `.env` / `dotenv` | Sort keys, keep comment blocks attached |
| `.properties` | Sort keys, keep comment blocks attached |
| `Plain Text` (.txt, etc.) | Sort lines A–Z |
| `Dart` folders | Generate barrel file |
| Any `git` repo | AI commit message generation |

---

## How to Use

### Sort a file
1. Open a supported file (e.g., `data.json`, `config.yaml`, `.env`).
2. **Right-Click** anywhere in the file → **"Sort Anything: Sort Document"**.
3. To sort a specific section, highlight text → **Right-Click** → **"Sort Anything: Sort Selection"**.
4. *(Alternatively: Command Palette `Ctrl+Shift+P` / `Cmd+Shift+P`)*

### Generate AI Commit Message
1. Stage your changes with `git add`.
2. Open the **Source Control** panel (`Ctrl+Shift+G`).
3. Click the **✨ sparkle icon** on the Source Control title bar (top right).
4. Select a provider from the dropdown:
   - **Gemini** — requires an API key (see configuration below).
   - **Ollama** — requires Ollama running locally (`ollama serve`).
5. A loading indicator `[Generating commit message...]` will appear directly inside the input box.
6. Once ready, the generated commit message is filled **directly** into the Git input box for you to review, edit, or commit.

### Generate Dart Barrel File
1. **Right-click a folder** in the VS Code Explorer.
2. Select **"Generate Dart Barrel File"**.
3. A `<folder_name>.dart` file will be created (or overwritten) with all exports sorted.

**Example output** for a folder named `models/`:
```dart
export 'post.dart';
export 'sub/category.dart';
export 'user.dart';
```

---

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `sortAnything.aiProvider` | `"gemini"` | Default AI provider (`gemini` or `ollama`) |
| `sortAnything.geminiApiKey` | `""` | Your Gemini API key — get one free at [aistudio.google.com](https://aistudio.google.com/apikey) |
| `sortAnything.geminiModel` | `"gemini-2.0-flash"` | Gemini model to use (e.g., `gemini-1.5-pro`) |
| `sortAnything.ollamaEndpoint` | `"http://localhost:11434"` | Ollama server endpoint |
| `sortAnything.ollamaModel` | `"llama3"` | Ollama model to use (e.g., `mistral`, `codellama`) |

> **Tip:** You can open settings directly from the **⚙️ Switch AI Provider / Configure...** option in the commit message dropdown.

---

## Release Notes

See the [CHANGELOG.md](CHANGELOG.md) for all release notes and version history.

---
*Created with ❤️ by [Dyno Nexsoft](https://github.com/dyno-nexsoft)* | [View Source on GitHub](https://github.com/dyno-nexsoft/sort_anything)
