const http = require("http");
const dns = require("dns");
const { URL } = require("url");

dns.setDefaultResultOrder("ipv4first");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const ZHIPU_API_BASE = process.env.ZHIPU_API_BASE || "https://open.bigmodel.cn/api/paas/v4";
const DEFAULT_MODEL = process.env.ZHIPU_MODEL || "glm-4.5v";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

const TEST_IMAGE_URL = "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=1200&q=80";

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, JSON_HEADERS);
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;

      if (raw.length > 8 * 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Request body must be valid JSON."));
      }
    });

    req.on("error", reject);
  });
}

function getBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (match && match[1]) {
    return match[1].trim();
  }

  if (process.env.ZHIPU_API_KEY) {
    return process.env.ZHIPU_API_KEY.trim();
  }

  return "";
}

async function fetchImageAsDataUrl(imageUrl) {
  let response;

  try {
    response = await fetch(imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 PromptReverseGlass/1.0",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        "Referer": imageUrl
      }
    });
  } catch (error) {
    throw new Error(`Failed to download source image: ${error.message}`);
  }

  if (!response.ok) {
    throw new Error(`Failed to download source image: HTTP ${response.status}`);
  }

  const contentType = (response.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  const arrayBuffer = await response.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  return `data:${contentType};base64,${base64}`;
}

function buildInstructionText() {
  return [
    "You are an expert prompt reverse-engineering assistant for creative imagery.",
    "Analyze the image and infer a polished image-generation prompt.",
    "Return JSON only with exactly three keys: analysis, prompt and tags.",
    "analysis must be written in Chinese and must explicitly cover these five parts in order:",
    "1. 风格流派与绘画技法",
    "2. 构图方式与视角",
    "3. 核心视觉元素与场景",
    "4. 色彩方案与光影效果",
    "5. 分辨率、质感等技术参数",
    "The analysis must be detailed, logically connected, and read like a professional reverse-engineering breakdown.",
    "prompt must be one final polished reverse-engineered prompt string in Chinese, optionally mixed with concise English style terms when useful.",
    "The prompt must be based on the five-part analysis above and directly usable in text-to-image tools to generate a closely matching work.",
    "tags must be an array of 3 to 8 short Chinese tags.",
    "Do not output markdown."
  ].join(" ");
}

function buildZhipuRequest({ imageUrl, model }) {
  return {
    model: model || DEFAULT_MODEL,
    messages: [
      {
        role: "system",
        content: "You are a precise multimodal prompt reverse-engineering assistant."
      },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: imageUrl
            }
          },
          {
            type: "text",
            text: `${buildInstructionText()} Example format: {"analysis":"...","prompt":"...","tags":["...","..."]}`
          }
        ]
      }
    ]
  };
}

function extractAssistantText(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  const content = message && message.content;

  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const textPart = content.find((item) => item && typeof item.text === "string");
    if (textPart && textPart.text) {
      return textPart.text.trim();
    }
  }

  return "";
}

function normalizeResult(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.prompt !== "string") {
    return null;
  }

  return {
    analysis: typeof raw.analysis === "string" ? raw.analysis.trim() : "",
    prompt: raw.prompt.trim(),
    tags: Array.isArray(raw.tags) ? raw.tags.filter(Boolean).map(String) : []
  };
}

async function callZhipu({ apiKey, imageUrl, imageDataUrl, model }) {
  const targetImageUrl = imageDataUrl || (
    imageUrl === "__LOCAL_TEST_IMAGE__"
      ? TEST_IMAGE_URL
      : await fetchImageAsDataUrl(imageUrl)
  );
  const endpoint = `${ZHIPU_API_BASE}/chat/completions`;

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(buildZhipuRequest({
        imageUrl: targetImageUrl,
        model
      }))
    });
  } catch (error) {
    throw new Error(`Failed to reach Zhipu API: ${error.message}`);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      (data && data.error && data.error.message) ||
      (data && data.message) ||
      `Zhipu request failed with status ${response.status}.`;

    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  const text = extractAssistantText(data);
  if (!text) {
    throw new Error("Zhipu returned no text output.");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error("Zhipu returned invalid JSON.");
  }

  const normalized = normalizeResult(parsed);
  if (!normalized || !normalized.prompt) {
    throw new Error("Zhipu result did not include a valid prompt.");
  }

  return normalized;
}

async function handleAnalyze(req, res) {
  const apiKey = getBearerToken(req);
  if (!apiKey) {
    sendJson(res, 401, {
      success: false,
      error: {
        code: "missing_api_key",
        message: "Missing bearer token. Fill the client API Key field with your Zhipu API key."
      }
    });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, {
      success: false,
      error: {
        code: "invalid_json",
        message: error.message
      }
    });
    return;
  }

  const imageUrl = typeof body.imageUrl === "string" ? body.imageUrl.trim() : "";
  const imageDataUrl = typeof body.imageDataUrl === "string" ? body.imageDataUrl.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";

  if (!imageUrl && !imageDataUrl) {
    sendJson(res, 400, {
      success: false,
      error: {
        code: "missing_image_payload",
        message: "imageUrl or imageDataUrl is required."
      }
    });
    return;
  }

  if (imageUrl && imageUrl !== "__LOCAL_TEST_IMAGE__") {
    try {
      new URL(imageUrl);
    } catch (error) {
      sendJson(res, 400, {
        success: false,
        error: {
          code: "invalid_image_url",
          message: "imageUrl must be a fully qualified URL."
        }
      });
      return;
    }
  }

  try {
    const result = await callZhipu({ apiKey, imageUrl, imageDataUrl, model });
    sendJson(res, 200, {
      success: true,
      result
    });
  } catch (error) {
    const statusCode = error.status || 500;
    console.error("[Zhipu backend error]", error.message, error.data || "");
    sendJson(res, statusCode, {
      success: false,
      message: error.message || "Analyze request failed.",
      error: {
        code: statusCode === 401 || statusCode === 403 ? "unauthorized" : "upstream_error",
        message: error.message || "Analyze request failed."
      }
    });
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, JSON_HEADERS);
    res.end();
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "prompt-reverse-glass-backend",
      analyzeUrl: `http://${HOST}:${PORT}/analyze`,
      provider: "zhipu-vlm",
      defaultModel: DEFAULT_MODEL,
      now: new Date().toISOString()
    });
    return;
  }

  if (req.method === "POST" && requestUrl.pathname === "/analyze") {
    await handleAnalyze(req, res);
    return;
  }

  sendJson(res, 404, {
    success: false,
    error: {
      code: "not_found",
      message: "Use POST /analyze or GET /health."
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Prompt Reverse Glass Zhipu backend listening on http://${HOST}:${PORT}`);
});
