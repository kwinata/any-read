// Server-side gate for the whole site. Every request passes through here;
// without the auth cookie only the app shell (lock screen) is served.
// The password is never stored — only its SHA-256, same value the app uses.
const PASS_HASH = "8c28ed22b31b278b871e4d8cd9f466e3bf53071db1cfde72c37c91cb7f1f70ed";
const COOKIE = "anyread";

// Paths needed to render the lock screen before login
const OPEN_PATHS = new Set([
  "/", "/index.html", "/app.js", "/style.css", "/manifest.webmanifest", "/sw.js",
]);

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default async (request: Request, context: { next: () => Promise<Response> }) => {
  const url = new URL(request.url);

  if (url.pathname === "/api/login" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const hash = await sha256Hex(String(body.password ?? ""));
    if (hash === PASS_HASH) {
      return new Response("ok", {
        headers: {
          "Set-Cookie":
            `${COOKIE}=${PASS_HASH}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
        },
      });
    }
    return new Response("unauthorized", { status: 401 });
  }

  const cookie = request.headers.get("cookie") || "";
  if (cookie.includes(`${COOKIE}=${PASS_HASH}`)) return context.next();
  if (OPEN_PATHS.has(url.pathname) || url.pathname.startsWith("/icons/")) {
    return context.next();
  }
  return new Response("Unauthorized", { status: 401 });
};
