// One JSON object per line, so Cloudflare's Workers Logs can filter on any field
// (e.g. event = "run.failed" or runId = "..."). View them in the dashboard under
// Workers & Pages → openugc-metrics → Logs, or live with `npx wrangler tail`.

type Fields = Record<string, unknown>;

const errorFields = (e: unknown): Fields =>
  e instanceof Error ? { error: e.message, stack: e.stack } : { error: String(e) };

export const log = {
  info(event: string, fields: Fields = {}) {
    console.log(JSON.stringify({ level: "info", event, ...fields }));
  },
  warn(event: string, fields: Fields = {}) {
    console.warn(JSON.stringify({ level: "warn", event, ...fields }));
  },
  error(event: string, e: unknown, fields: Fields = {}) {
    console.error(JSON.stringify({ level: "error", event, ...fields, ...errorFields(e) }));
  },
};
