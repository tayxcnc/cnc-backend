import { bootstrap } from './bootstrap';

/**
 * Entry point for the CNC Cloud Run service. Listens on `PORT` (injected by
 * Cloud Run; 3000 locally).
 *
 * Reads nothing from the environment: every setting goes through
 * `CncConfigService` inside `bootstrap()`. There is deliberately no Vercel
 * preview pattern here, unlike TAY's entry point. A pattern admits any
 * hostname that matches it, and anyone can register a Vercel project whose
 * name matches, so a developer who points a preview at a local API lists
 * that exact origin in their local `CNC_CORS_ORIGINS` instead.
 */
void bootstrap();
