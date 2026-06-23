<div align="center">
  <img src="icon.png" width="128" height="128" alt="Sort Anything Icon" />
  <h1>Sort Anything</h1>
  <p>A simple, yet powerful VS Code extension to sort data files and generate Dart barrel files.</p>
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

### 🎯 Dart Barrel File Generator
- **Right-click any folder** in the Explorer → **"Generate Dart Barrel File"**
- Recursively scans all `.dart` files in the folder and sub-folders.
- Automatically skips `part of` files (they cannot be independently exported).
- Generates a `<folder_name>.dart` barrel file with sorted `export` statements.
- Overwrites the existing barrel file to keep it in sync with the folder.

## Supported Formats

| Format | Feature |
|---|---|
| `JSON` / `JSONC` | Sort keys, preserve comments |
| `YAML` | Sort keys, preserve comments & structure |
| `.env` / `dotenv` | Sort keys, keep comment blocks attached |
| `.properties` | Sort keys, keep comment blocks attached |
| `Plain Text` (.txt, etc.) | Sort lines A-Z |
| `Dart` folders | Generate barrel file |

## How to use

### Sort a file
1. Open a supported file (e.g., `data.json`, `config.yaml`, `.env`).
2. **Right-Click** anywhere in the file → **"Sort Anything: Sort Document"**.
3. To sort a specific section, highlight text → **Right-Click** → **"Sort Anything: Sort Selection"**.
4. *(Alternatively: Command Palette `Ctrl+Shift+P` / `Cmd+Shift+P`)*

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

## Extension Settings

This extension uses your default VS Code indentation settings (Tabs or Spaces) to format the output.

## Release Notes

### 0.0.6
- Removed generated header comment from Dart barrel files for a cleaner output.

### 0.0.5
- Added **Dart Barrel File Generator** via Explorer right-click context menu.
- Barrel file is named `<folder_name>.dart`, sorted, and overwrites existing file.

### 0.0.4
- Fixed JSONC comment preservation using `comment-json` library.
- Fixed `.env` multiline value handling.
- Fixed trailing blank lines being sorted to the top in plain text files.
- Added status bar feedback messages.

### 0.0.1 – 0.0.3
- Initial release with JSON, YAML, .env, .properties, and Plain Text sorting.
- Added Right-Click context menu support.

---
*Created with ❤️ by [Dyno Nexsoft](https://github.com/dyno-nexsoft)* | [View Source on GitHub](https://github.com/dyno-nexsoft/sort_anything)
