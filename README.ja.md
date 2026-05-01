# Pi Web Access クイックスタート

[English](./README.md) | [简体中文](./README.zh-CN.md) | [Español](./README.es.md)

Pi Web Access は Pi agent に Web 検索、URL 取得、GitHub リポジトリ取得、PDF 抽出、YouTube / ローカル動画理解を追加します。

## できること

- Exa、Perplexity、Gemini による Web 検索
- ページを読みやすい Markdown として取得
- GitHub URL をスクレイピングせずローカル clone として扱う
- YouTube 動画やローカル録画について質問する
- PDF からテキストを抽出する
- `ffmpeg` / `yt-dlp` がある場合、指定時刻の動画フレームを画像として抽出する

## インストール

```bash
pi install npm:pi-web-access
```

API キーなしでも Exa MCP により検索できます。追加プロバイダーや直接 API を使う場合は `~/.pi/web-search.json` にキーを追加します。

```json
{
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza..."
}
```

## すぐ使う

```typescript
web_search({ query: "TypeScript best practices 2025" })
fetch_content({ url: "https://docs.example.com/guide" })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
```

## 動画フレーム抽出（任意）

```bash
brew install ffmpeg
brew install yt-dlp
```

これらがなくても、Gemini による動画内容分析、文字起こし、視覚説明は利用できます。個別フレーム抽出にのみ必要です。

## 主な注意点

- デフォルトの `auto` 検索は Exa → Perplexity → Gemini API → Gemini Web の順に試します。
- GitHub リポジトリは実ファイルとして扱うため、agent が `read` や `bash` で探索できます。
- プライベート GitHub リポジトリには `gh` CLI が必要です。
- Pi v0.37.3 以上が必要です。

完全な詳細は [English README](./README.md) を参照してください。
