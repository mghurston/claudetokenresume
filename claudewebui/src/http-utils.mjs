import { readFile } from "node:fs/promises";
import path from "node:path";

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export function applySecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "style-src 'self'",
    "script-src 'self'",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "));
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

export function json(response, statusCode, payload) {
  applySecurityHeaders(response);
  response.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

export function errorJson(response, error, statusCode = 500) {
  json(response, statusCode, {
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function readJson(request, maximumBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}

export function enforceSameOrigin(request, expectedOrigins) {
  const origin = request.headers.origin;
  const allowedOrigins =
    expectedOrigins instanceof Set ? expectedOrigins : new Set([expectedOrigins]);
  if (origin && !allowedOrigins.has(origin)) {
    const error = new Error("Cross-origin requests are not allowed.");
    error.statusCode = 403;
    throw error;
  }
}

export async function serveStatic(response, publicDirectory, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(publicDirectory, requested);
  const relative = path.relative(publicDirectory, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }

  try {
    const body = await readFile(filePath);
    applySecurityHeaders(response);
    response.writeHead(200, {
      // Everything revalidates, not just index.html. `max-age=300` on the
      // scripts meant an updated Studio kept serving the old app.js for up to
      // five minutes — which quietly defeats the Restart button, since you
      // restart precisely to pick up a new version. Revalidation is free over
      // loopback.
      "Cache-Control": "no-cache",
      "Content-Type": CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream",
    });
    response.end(body);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      return false;
    }
    throw error;
  }
}
