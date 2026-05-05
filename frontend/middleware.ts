import { auth } from "@/auth";

export default auth((req) => {
  const path = req.nextUrl.pathname;
  const authed = !!req.auth;

  if (
    path.startsWith("/api/auth") ||
    path.startsWith("/_next") ||
    path === "/favicon.ico"
  ) {
    return;
  }

  const publicPaths = new Set(["/", "/login", "/signup", "/reset-password"]);
  const isPublic = publicPaths.has(path);
  const needsApp =
    path === "/dashboard" ||
    path.startsWith("/dashboard/") ||
    path === "/ace" ||
    path.startsWith("/ace/");

  if (!authed && needsApp) {
    const u = req.nextUrl.clone();
    u.pathname = "/login";
    return Response.redirect(u);
  }
  if (authed && (path === "/login" || path === "/signup")) {
    const u = req.nextUrl.clone();
    u.pathname = "/dashboard";
    return Response.redirect(u);
  }
  if (authed && path === "/") {
    const u = req.nextUrl.clone();
    u.pathname = "/dashboard";
    return Response.redirect(u);
  }
  if (!authed && !isPublic) {
    const u = req.nextUrl.clone();
    u.pathname = "/login";
    return Response.redirect(u);
  }
});

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"
  ]
};
