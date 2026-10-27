---
summary: "Connect a GitLab account with per-user OAuth for managed-session publication"
read_when:
  - Configuring GitLab publication
  - Understanding GitLab publication identity and recovery
---

# GitLab connections and publication

GitLab publication uses a connected human account selected in the session's
publication flow. Credentials stay on the Gateway. Each user connects their own
account; another participant's connection cannot authorize publication for them.
A missing, expired or disconnected user connection does not fall back to a
shared account or an ambient CLI token.

## Configure the Gateway

Register a non-confidential GitLab OAuth application supporting authorization code
with PKCE. Enable `api` and `write_repository`, and register an exact HTTPS
redirect URI under your control. Configure its public application ID, issuer and
an optional project restriction:

```json5
{
  gateway: {
    gitlab: {
      issuer: "https://gitlab.example.com",
      clientId: "YOUR_PUBLIC_APPLICATION_ID",
      redirectUri: "https://gateway.example.com/oauth/gitlab",
      // Optional: restrict publication to these numeric project IDs.
      // Omit to use the connected user's normal GitLab project access.
      projects: [17],
    },
  },
}
```

The redirect page must let the user retain the complete returned URL. In
**Settings → Profile → Git connections → Add provider**, choose **GitLab**,
complete authorization in the browser, and paste the returned URL into the
protected connection form. The request is bound to the initiating user and can
be completed once. Reconnect when refresh fails.

## Publish from a session

The session must have a locally managed publication worktree and a canonical
HTTPS `origin` on the configured issuer, ending in `.git`. The repository must
resolve to the exact canonical project using the connected user's access. The repository remote selects the provider;
changing a branch does not change the provider or destination project.

Publication records the selected human publisher, creates the Git commit with
their verified GitLab commit identity, and checks the remote branch SHA. An
existing merge request retains its original author; the current publisher is
reported separately. Accepted requests retain their identity and idempotency key.
After an interrupted or uncertain remote operation, recover that request before
starting a replacement. Disconnecting does not erase completed publication
status or transfer accepted requests to another user.

## Issue skills and other GitLab operations

This connection authorizes browser-selected publication. It does not sign the
agent's shell into GitLab or supply tokens to issue skills. Ordinary GitLab CLI
skills use their independently configured credentials and must verify the actual
actor and explicit repository before acting. A request for a personal identity
must stop when that identity is unavailable. Do not copy browser tokens into CLI
configuration or silently substitute another account.

This feature does not add cross-repository issue orchestration or a shared GitLab
publication account configuration.
