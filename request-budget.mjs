// Local safety budgets, not advertised upstream limits.
export const MAX_REQUEST_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
// Observed upstream limit (2026-11-01): a 21st image in one chat request is
// rejected as HTTP 503 "Service unavailable" code 3800, not as a 4xx.
export const MAX_REQUEST_IMAGES = 20;
