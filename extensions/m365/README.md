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
              "timeZone": "America/New_York",
              "weekStartsOn": "monday",
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

## Chief-of-staff read foundation

Use `m365_calendar_view` for any bounded time question. It accepts exact ISO
8601 start/end values, uses Microsoft Graph `calendarView` so recurring event
instances are expanded, requests the owner's configured timezone, follows
pagination, and reports whether the requested range was completely covered.
`m365_calendar_list` remains available only as a compatibility path for simple
"next events" requests.

Use `m365_calendar_search` to find meetings by topic or person within an exact
range, and `m365_calendar_event_read` to retrieve a selected event. Use
`m365_mail_search` for bounded mailbox discovery by dates, sender, subject,
conversation, read state, or attachment presence.

The new read tools return a common trust envelope:

- owner and normalized query
- resolved time range and effective timezone
- items and source freshness
- pages read and `coverageComplete`
- warnings, errors, and a trace id

An empty `items` array is a trustworthy "none found" answer only when
`coverageComplete` is true. The agent should display the resolved dates for
relative requests such as "this week" and should describe partial coverage
instead of claiming there was no activity.

Directory, tasks, files, SharePoint, and Teams are separate authorization lanes.
Do not add their Graph permissions to this Exchange-scoped credential. Those
capabilities should be implemented as separately configured connectors and
then composed at the assistant layer.

Secrets belong in the runtime host's configured secret provider. Do not commit
client secrets or reuse the Teams bot credential for Graph.
