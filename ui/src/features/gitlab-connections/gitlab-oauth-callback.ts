import type { RouteLocation } from "@openclaw/uirouter";

let pendingCallback: string | null = null;

/** Capture before routing or transport startup; never persist an authorization code. */
export function captureGitLabOAuthCallback(
  location: RouteLocation,
  basePath: string,
  origin: string,
): RouteLocation {
  if (location.pathname !== `${basePath}/oauth/gitlab/callback`) {
    return location;
  }
  pendingCallback = `${origin}${location.pathname}${location.search}${location.hash}`;
  return { pathname: `${basePath}/settings/profile`, search: "", hash: "" };
}

/** The authenticated Profile presenter hands this once to the Gateway's owner-bound flow. */
export function takeGitLabOAuthCallback(): string | null {
  const callback = pendingCallback;
  pendingCallback = null;
  return callback;
}
