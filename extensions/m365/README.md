# Microsoft 365 Graph Plugin

OpenClaw plugin for owner-scoped Microsoft Graph mail and calendar tools.

The plugin is intentionally account-mapped. Runtime tool context provides the
OpenClaw account id, such as `ea-alex-wilber`; plugin config maps that id to an
Entra app id, tenant id, client-secret SecretRef, mailbox, optional agent id
allowlist, and optional channel allowlist.

Example config shape:

```json
{
  "plugins": {
    "entries": {
      "m365": {
        "enabled": true,
        "config": {
          "accounts": {
            "ea-alex-wilber": {
              "tenantId": "28bc65e7-4cf0-4445-870c-addb186ecb14",
              "clientId": "dee92ffa-a755-4011-8826-2e2bba3f4df3",
              "clientSecret": {
                "source": "env",
                "provider": "default",
                "id": "M365_EA_ALEX_WILBER_CLIENT_SECRET"
              },
              "mailbox": "AlexW@M365B693655.OnMicrosoft.com",
              "allowedAgentIds": ["ea-alex-wilber"],
              "allowedChannels": ["msteams"],
              "allowWrites": false
            }
          }
        }
      }
    }
  }
}
```

When OpenClaw uses a restrictive tool profile such as `coding`, add the plugin
only to the intended EA entry:

```json
{
  "agents": {
    "list": [
      {
        "id": "ea-alex-wilber",
        "tools": { "alsoAllow": ["m365"] }
      }
    ]
  }
}
```

Installing and enabling the plugin does not bypass the active tool profile.
Do not add the plugin globally when only named EAs should receive the tools.

Keep `allowWrites` disabled for read-only pilots. When writes are approved, the
write tools still require explicit confirmation arguments (`SEND`, `CREATE`,
`UPDATE`, or `RESPOND`). The read path needed for "summarize my last 5 emails"
is `m365_mail_list_recent`, followed by `m365_mail_read` only when the preview
is insufficient.

Calendar create/update support real meeting-shaped events:

- `attendees`: email addresses to invite as required attendees
- `location`: optional display name
- `body`: optional plain-text body

Calendar RSVP support:

- `m365_calendar_respond` accepts, declines, or tentatively accepts an invite
  with `response` set to `accept`, `decline`, or `tentative`.
- RSVP writes require `confirm: "RESPOND"`.

The tool never accepts a mailbox parameter from the model. Mailbox selection is
owned by the OpenClaw account mapping.

Secrets belong in the runtime host's configured secret provider. Do not commit
client secrets or reuse the Teams bot credential for Graph.
