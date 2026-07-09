# GEMINI.md — Agent Instructions for Sort Anything

File này hướng dẫn AI agent làm việc đúng quy trình trong project này.

## ⚙️ Development Workflow

> [!IMPORTANT]
> **Luôn tuân thủ đúng quy trình sau, không bỏ bước nào:**

1. **Code** — Viết/sửa code trong `src/`
2. **Compile** — Chạy `cmd /c npm run compile` để kiểm tra lỗi TypeScript
3. **Build to Desktop** — Chạy `cmd /c npm run package-to-desktop` để xuất file `.vsix` ra Desktop cho user test
4. **Chờ user xác nhận** — KHÔNG commit, KHÔNG push, KHÔNG tạo tag cho đến khi user nói OK
5. **Commit + Push + Tag** — Sau khi user xác nhận:
   ```
   git add . ; git commit -m "..." ; git push origin master ; git tag vX.X.X ; git push origin vX.X.X
   ```

## 📦 Project Structure

```
sort_anything/
├── src/
│   ├── extension.ts       # Entry point, đăng ký commands
│   ├── sorter.ts          # Logic sort JSON/YAML/ENV/plaintext
│   ├── barrelGenerator.ts # Logic tạo Dart barrel file
│   └── utils.ts           # Helper (getIndent)
├── .github/workflows/
│   └── release.yml        # GitHub Action: tự build .vsix khi push tag
├── package.json           # Extension manifest, commands, menus
├── README.md              # Tài liệu người dùng
└── GEMINI.md              # File này — hướng dẫn agent
```

## 🚀 Useful Commands

| Lệnh                                | Mục đích                         |
| ----------------------------------- | -------------------------------- |
| `cmd /c npm run compile`            | Compile TypeScript, kiểm tra lỗi |
| `cmd /c npm run package-to-desktop` | Build `.vsix` ra Desktop         |
| `cmd /c npm run watch`              | Watch mode khi đang dev          |

> [!WARNING]
> Dùng `cmd /c` thay vì chạy thẳng `npm` vì PowerShell trên máy này bị giới hạn execution policy.

## 📋 Versioning

- Bump version trong `package.json` mỗi khi có thay đổi đáng kể trước khi tạo tag.
- Tag format: `vX.X.X` (e.g., `v0.0.5`)
- GitHub Action tự động build và tạo Release khi push tag.

## 🧠 Key Technical Decisions

- **JSON comments**: Dùng thư viện `comment-json` (KHÔNG dùng `JSON.parse` vì mất comment, KHÔNG dùng `jsonc-parser` vì không giữ được comment khi stringify).
- **YAML**: Dùng thư viện `yaml` v2, sort in-place trên AST để giữ comment.
- **ENV/Properties**: Sort theo "block" — comment và dòng trống được gắn vào key phía dưới rồi mới sort, tránh comment bị tách rời.
- **Barrel file**: Tên file = `<tên_folder>.dart`, đệ quy sub-folder, bỏ qua file `part of`, overwrite nếu đã tồn tại.

## 🗑️ Files cần dọn dẹp

- `test_comment_json.js` ở root — file test tạm, nên xóa trước khi release chính thức.
- `sort-anything-0.0.1.vsix` ở root — file vsix cũ, nên xóa.
