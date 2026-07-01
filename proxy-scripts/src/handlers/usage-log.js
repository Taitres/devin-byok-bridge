function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function toUsageObject(value) {
  return value && typeof value === "object" ? value : {};
}

export function mergeUsage(base = {}, patch = {}) {
  const safeBase = toUsageObject(base);
  const safePatch = toUsageObject(patch);
  const next = {
    input_tokens: toNumber(safeBase.input_tokens),
    output_tokens: toNumber(safeBase.output_tokens),
    cache_creation_input_tokens: toNumber(safeBase.cache_creation_input_tokens),
    cache_read_input_tokens: toNumber(safeBase.cache_read_input_tokens),
    cached_tokens: toNumber(safeBase.cached_tokens)
  };
  for (const [key, value] of Object.entries(safePatch)) {
    if (value == null) {
      continue;
    }
    if (key in next) {
      next[key] = toNumber(value);
    }
  }
  return next;
}

function getCachedInputTokenCount(usage = {}) {
  const safeUsage = toUsageObject(usage);
  return toNumber(safeUsage.cache_read_input_tokens) || toNumber(safeUsage.cached_tokens);
}

export function computeCacheHitRate(usage = {}) {
  const safeUsage = toUsageObject(usage);
  const input = toNumber(safeUsage.input_tokens);
  const cached = getCachedInputTokenCount(safeUsage);
  if (input <= 0 || cached <= 0) {
    return 0;
  }
  return Math.min(100, Math.round(cached * 100 / input));
}

export function formatUsageLog(usage = {}, provider = "", meta = {}) {
  const safeMeta = toUsageObject(meta);
  const merged = mergeUsage(usage);
  const cached = getCachedInputTokenCount(merged);
  const creation = merged.cache_creation_input_tokens;
  const hitRate = computeCacheHitRate(merged);
  const prefix = provider ? provider + " " : "";
  const parts = [
    prefix + "tokens: input=" + merged.input_tokens,
    "output=" + merged.output_tokens
  ];
  if (cached > 0 || creation > 0) {
    parts.push("cached=" + cached);
    parts.push("creation=" + creation);
    parts.push("hit=" + hitRate + "%");
  } else {
    parts.push("cached=0");
  }
  if (safeMeta.mode) {
    parts.push("mode=" + safeMeta.mode);
  }
  if (safeMeta.route) {
    parts.push("route=" + safeMeta.route);
  }
  if (safeMeta.cacheStatus) {
    parts.push("cache=" + safeMeta.cacheStatus);
  }
  if (Number.isFinite(safeMeta.requestBytes) && safeMeta.requestBytes > 0) {
    parts.push("req=" + safeMeta.requestBytes + "b");
  }
  if (safeMeta.fallback) {
    parts.push("fallback=" + safeMeta.fallback);
  }
  return "📊 " + parts.join(" ");
}

export function extractAnthropicUsage(event = {}) {
  const usage = event?.data?.message?.usage || event?.data?.usage;
  if (!usage) {
    return null;
  }
  return mergeUsage({
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens
  });
}

export function extractOpenAIResponsesUsage(event = {}) {
  const usage = event?.data?.response?.usage || event?.data?.usage;
  if (!usage) {
    return null;
  }
  const cached = usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens;
  return mergeUsage({
    input_tokens: usage.input_tokens ?? usage.prompt_tokens,
    output_tokens: usage.output_tokens ?? usage.completion_tokens,
    cached_tokens: cached
  });
}

export function extractChatCompletionsUsage(chunk = {}) {
  const usage = chunk?.usage;
  if (!usage) {
    return null;
  }
  const cached = usage.prompt_tokens_details?.cached_tokens ?? usage.cached_tokens;
  return mergeUsage({
    input_tokens: usage.prompt_tokens ?? usage.input_tokens,
    output_tokens: usage.completion_tokens ?? usage.output_tokens,
    cached_tokens: cached
  });
}
