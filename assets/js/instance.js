// Which copy of the site this is. The deploy publishes the app once at the site root and
// once per folder under instances/ (e.g. /gino/), for colleagues. Copies share the origin,
// so every storage key is suffixed with the instance name to keep their picks apart.

const meta = typeof document !== 'undefined' ? document.querySelector('meta[name="planner-instance"]') : null;
export const INSTANCE = (meta?.content || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
export const INSTANCE_LABEL = INSTANCE ? INSTANCE[0].toUpperCase() + INSTANCE.slice(1) : '';
export const nsKey = key => (INSTANCE ? `${key}@${INSTANCE}` : key);
// The guide for AI assistants is published next to each copy's page (the deploy rewrites
// its links for the copy), so this page's own folder is the right one: /gino/llms.txt for Gino.
export const guideUrl = pageUrl => new URL('llms.txt', pageUrl).href;
