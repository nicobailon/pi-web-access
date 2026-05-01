# Pi Web Access: inicio rápido

[English](./README.md) | [日本語](./README.ja.md) | [简体中文](./README.zh-CN.md)

Pi Web Access añade al agente Pi búsqueda web, extracción de URLs, clonación de repositorios GitHub, extracción de PDF y comprensión de videos de YouTube o archivos locales.

## Qué hace

- Busca en la web con Exa, Perplexity y Gemini
- Convierte páginas en Markdown legible
- Clona URLs de GitHub localmente en vez de raspar HTML renderizado
- Permite hacer preguntas sobre videos de YouTube o grabaciones locales
- Extrae texto de PDFs
- Con `ffmpeg` / `yt-dlp`, extrae frames de video en timestamps exactos

## Instalación

```bash
pi install npm:pi-web-access
```

Funciona sin API keys mediante Exa MCP. Para más providers o acceso directo por API, agrega claves en `~/.pi/web-search.json`.

```json
{
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza..."
}
```

## Uso rápido

```typescript
web_search({ query: "TypeScript best practices 2025" })
fetch_content({ url: "https://docs.example.com/guide" })
fetch_content({ url: "https://github.com/owner/repo" })
fetch_content({ url: "https://youtube.com/watch?v=abc", prompt: "What libraries are shown?" })
fetch_content({ url: "/path/to/recording.mp4", prompt: "What error appears on screen?" })
```

## Extracción de frames de video (opcional)

```bash
brew install ffmpeg
brew install yt-dlp
```

Sin estas herramientas, el análisis de contenido de video, transcripciones y descripciones visuales con Gemini siguen funcionando. Solo son necesarias para extraer frames individuales como imágenes.

## Notas importantes

- La búsqueda `auto` prueba Exa → Perplexity → Gemini API → Gemini Web.
- Los repositorios GitHub se tratan como archivos reales, para que el agente pueda explorarlos con `read` y `bash`.
- Los repositorios GitHub privados requieren `gh` CLI.
- Requiere Pi v0.37.3 o superior.

Consulta los detalles completos en el [README en inglés](./README.md).
