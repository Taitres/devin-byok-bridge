import fs from "node:fs";
import path from "node:path";

const DEFAULT_SYSTEM_PROMPT_PATH = "./prompts/system-prompt.md";
let _promptCache = {
  path: "",
  mtimeMs: 0,
  size: -1,
  content: ""
};
let _lastWarnKey = "";

function compactPromptText(value) {
  return String(value || "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function resolvePromptPath(value) {
  const raw = String(value || DEFAULT_SYSTEM_PROMPT_PATH).trim() || DEFAULT_SYSTEM_PROMPT_PATH;
  if (path.isAbsolute(raw)) {
    return raw;
  }
  return path.resolve(process.cwd(), raw);
}

function readPromptFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return "";
    }
    if (_promptCache.path === filePath && _promptCache.mtimeMs === stat.mtimeMs && _promptCache.size === stat.size) {
      return _promptCache.content;
    }
    const content = fs.readFileSync(filePath, "utf8");
    _promptCache = {
      path: filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      content
    };
    return content;
  } catch (error) {
    const warnKey = filePath + ":" + (error && error.code || error && error.message || "error");
    if (_lastWarnKey !== warnKey) {
      _lastWarnKey = warnKey;
      console.warn("  ⚠️  Failed to read custom system prompt: " + filePath + " (" + (error && error.message || String(error)) + ")");
    }
    return "";
  }
}

export function clearSystemPromptCache() {
  _promptCache = {
    path: "",
    mtimeMs: 0,
    size: -1,
    content: ""
  };
  _lastWarnKey = "";
}

export function getActiveSystemPromptText(config = {}) {
  if (!config || config.systemPromptOverride !== true) {
    return "";
  }
  if (typeof config.systemPromptText === "string" && config.systemPromptText.trim()) {
    return compactPromptText(config.systemPromptText);
  }
  const filePath = resolvePromptPath(config.systemPromptPath);
  return compactPromptText(readPromptFile(filePath));
}

export function applySystemPromptOverride(basePrompt, config = {}) {
  const customPrompt = getActiveSystemPromptText(config);
  if (!customPrompt) {
    return compactPromptText(basePrompt);
  }
  return customPrompt;
}
