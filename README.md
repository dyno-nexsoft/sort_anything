<div align="center">
  <img src="icon.png" width="128" height="128" alt="Sort Anything Icon" />
  <h1>Sort Anything</h1>
  <p>A simple, yet powerful extension to sort your JSON, YAML, .env, and .properties files alphabetically.</p>
</div>

## Features

- **Sort Document**: Sorts all the keys in your current file alphabetically.
- **Sort Selection**: Sorts only the keys within your highlighted selection.
- **Maintains formatting**: Preserves YAML comments and structures safely. Groups `.env` and `.properties` lines logically!
- **Recursive sorting**: Deeply sorts nested objects in JSON and YAML files.

## Supported Formats

- `JSON`
- `JSONC` (JSON with comments)
- `YAML`
- `.env` / `dotenv`
- `.properties`

## How to use

1. Open a supported file (e.g., `data.json`, `config.yaml`, `.env`).
2. Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux, `Cmd+Shift+P` on macOS).
3. Type **"Sort Anything: Sort Document"** and hit Enter to sort the whole file.
4. Alternatively, highlight a specific block of text and run **"Sort Anything: Sort Selection"**.

## Extension Settings

Currently, this extension uses your default VS Code indentation settings (Tabs or Spaces) to format the output.

## Release Notes

### 0.0.1
- Initial release with support for JSON, YAML, .env, and .properties.

---
*Created with ❤️ by you!*
