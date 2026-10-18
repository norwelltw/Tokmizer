const PROD_BASE_URL = "https://tokmizer.com";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function baseUrlFromEnv(): string {
  const raw = process.env.TOKMIZER_BASE_URL;
  if (raw === PROD_BASE_URL || raw === `${PROD_BASE_URL}/`) return PROD_BASE_URL;
  if (!raw) return PROD_BASE_URL;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname) && !url.username && !url.password ? raw : PROD_BASE_URL;
  } catch {
    return PROD_BASE_URL;
  }
}
