/**
 * The API contract this dashboard was written for. Must equal API_REVISION in
 * backend/app/api/health.py. A backend reporting a lower number (or none) is
 * running older code, usually because it was not restarted after an update.
 * Kept apart from api.ts so the browser tests can read it outside Vite.
 */
export const REQUIRED_API_REVISION = 9
