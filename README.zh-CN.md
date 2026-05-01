# Pi Web Access 快速开始

[English](./README.md) | [日本語](./README.ja.md) | [Español](./README.es.md)

Pi Web Access 为 Pi agent 添加网页搜索、URL 抓取、GitHub 仓库获取、PDF 提取、YouTube / 本地视频理解能力。

## 能做什么

- 使用 Exa、Perplexity、Gemini 搜索网页
- 将网页提取为易读 Markdown
- 对 GitHub URL 进行本地 clone，而不是抓取渲染后的 HTML
- 对 YouTube 视频或本地录屏提问
- 从 PDF 提取文本
- 安装 `ffmpeg` / `yt-dlp` 后，可按时间戳提取视频帧图片

## 安装

```bash
pi install npm:pi-web-access
```

没有 API key 也可以通过 Exa MCP 进行搜索。若需要更多 provider 或直接 API 访问，请在 `~/.pi/web-search.json` 中添加 key。

```json
{
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza..."
}
```

## 立即使用

```typescript
web_search({ query: "TypeScript best practices 2025" })
fetch_content({ url: "https://docs.example.com/guide" })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
```

## 视频帧提取（可选）

```bash
brew install ffmpeg
brew install yt-dlp
```

即使不安装这些工具，仍可使用 Gemini 进行视频内容分析、转录和视觉描述。它们只用于提取单独的视频帧图片。

## 主要注意事项

- 默认 `auto` 搜索顺序为 Exa → Perplexity → Gemini API → Gemini Web。
- GitHub 仓库会作为真实文件处理，agent 可以用 `read` 和 `bash` 探索。
- 私有 GitHub 仓库需要 `gh` CLI。
- 需要 Pi v0.37.3 或更高版本。

完整细节见 [English README](./README.md)。
