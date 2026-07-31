# Aura Mobile Backend

The backend is kept in this directory so it remains separate from the frontend at the repository root.

## Requirements

- Node.js 20 or newer
- Python 3.11 with `yt-dlp`
- Deno for the `yt-dlp` JavaScript runtime

## Setup

```bash
npm ci
cp .env.example .env
```

Set `DEEPSEEK_API_KEY` and a long, random `URL_SECRET` before enabling the AI endpoints. Runtime data, audio cache files, YouTube cookies, and `.env` files are intentionally excluded from Git.

Start the server with environment variables loaded by your process manager:

```bash
npm start
```

Run the test suite with:

```bash
npm test
```

Deployment examples are included in `music-backend.service`, `yt-dlp-update.crontab`, and `ops/`. Adjust their absolute paths for the target host.
