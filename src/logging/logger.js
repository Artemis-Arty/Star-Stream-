"use strict";

/**
 * Minimal leveled logger. No dependencies, low memory.
 * Never logs secrets (tokens/URLs are redacted).
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const MIN_LEVEL = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function redact(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/(token|authorization|password|secret)=?\s*[:=]?\s*\S+/gi, "$1=[redacted]")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted-db-url]");
}

function format(level, args) {
  const time = new Date().toISOString();
  const parts = args.map((arg) => {
    if (arg instanceof Error) {
      return redact(arg.stack || arg.message);
    }
    if (typeof arg === "object" && arg !== null) {
      try {
        return redact(JSON.stringify(arg));
      } catch {
        return "[unserializable]";
      }
    }
    return redact(String(arg));
  });
  return `${time} [${level.toUpperCase()}] ${parts.join(" ")}`;
}

function log(level, args) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const line = format(level, args);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

const logger = {
  debug: (...args) => log("debug", args),
  info: (...args) => log("info", args),
  warn: (...args) => log("warn", args),
  error: (...args) => log("error", args),
};

module.exports = { logger };
