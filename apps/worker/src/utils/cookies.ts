// Minimal cookie helpers for the Worker. Cookies are HttpOnly, SameSite=Lax,
// and Secure when running outside dev (`APP_ENV !== "development"`).

export function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export interface SetCookieOptions {
  name: string;
  value: string;
  expires?: Date;
  maxAgeSeconds?: number;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export function buildSetCookie(options: SetCookieOptions): string {
  const parts: string[] = [`${options.name}=${encodeURIComponent(options.value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

export function buildClearCookie(name: string, opts: { secure?: boolean } = {}): string {
  return buildSetCookie({
    name,
    value: "",
    path: "/",
    expires: new Date(0),
    maxAgeSeconds: 0,
    secure: opts.secure ?? false,
    httpOnly: true,
    sameSite: "Lax",
  });
}
