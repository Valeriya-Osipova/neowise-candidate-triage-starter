export const DEFAULT_TIMEOUT_MS = 300;

const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);

export function resolveTimeoutMs(value = process.env.TRIAGE_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return parsed;
}

function invalidInput() {
  return { httpStatus: 400, body: { status: "invalid_input" } };
}

function manualReview() {
  return { httpStatus: 200, body: { status: "manual_review", topic: null, draft: null } };
}

function interpretModel(raw) {
  if (typeof raw !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!ALLOWED_TOPICS.has(parsed.topic)) return null;
  if (typeof parsed.draft !== "string" || parsed.draft.trim() === "") return null;
  return {
    httpStatus: 200,
    body: { status: "ready", topic: parsed.topic, draft: parsed.draft.trim() },
  };
}

export async function triageText(text, { classifyFn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof text !== "string" || text.trim() === "") return invalidInput();

  const trimmed = text.trim();
  const controller = new AbortController();
  let timer;

  const timedOut = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(manualReview());
    }, timeoutMs);
  });

  const classified = Promise.resolve()
    .then(() => classifyFn(trimmed, { signal: controller.signal }))
    .then((raw) => interpretModel(raw) ?? manualReview())
    .catch(() => manualReview());

  try {
    return await Promise.race([classified, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
