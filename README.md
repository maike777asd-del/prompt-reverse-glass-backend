# Prompt Reverse Glass Backend

Minimal backend for deploying Prompt Reverse Glass on Render.

## What this service does

- Accepts `POST /analyze`
- Receives `imageUrl` or `imageDataUrl`
- Calls Zhipu AI vision model
- Returns:

```json
{
  "success": true,
  "result": {
    "analysis": "详细反推分析",
    "prompt": "最终提示词",
    "tags": ["标签1", "标签2"]
  }
}
```

## Environment variables

- `ZHIPU_API_KEY`
- `ZHIPU_MODEL` optional, default is `glm-4.5v`

## Render settings

- Build Command: leave empty
- Start Command: `npm start`

## Health check

- `GET /health`

