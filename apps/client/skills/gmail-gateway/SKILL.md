---
name: gmail-gateway
description: The Gmail Gateway Skill enables the assistant to interact with a user's Gmail inbox through a secure internal gateway. It is optimized for triage and retrieval, allowing users to scan their most recent correspondence and access full message details without leaving the interface.
read_when:
  - asked about recent emails
  - asked about specific email details
  - asked to check Gmail inbox
  - asked to list recent emails
---

<overview>Fetch and work with the user's last 15 received Gmail messages via the internal API.</overview>

<rules>
  <rule name="data_enforcement">You MUST base your response strictly on the data returned from the API response or the `recent_emails` command. Do not hallucinate, guess, or invent information under any circumstances.</rule>
  <rule name="empty_data_handling">If the API returns no data, or the email list is empty, you must explicitly state that no information was found. Do not invent details to fill the gap; adapt your response to acknowledge the lack of data.</rule>
  <rule>include email IDs in your responses whenever referencing specific emails, as this allows for accurate follow-up commands to retrieve snippets or full details.</rule>
</rules>

<commands>
  <command>
    <trigger>Get Recent Emails</trigger>
    <request>
      <description>Fetch the last 15 emails received. Use the compact jq filter below to extract only essential fields — this keeps the response small enough to return all emails without truncation.</description>
      <bash>curl -X GET <GMAIL_GATEWAY_HOST>/api/emails/recent | jq '[.data.emails[] | {id, from, subject, date, isUnread}]'</bash>
    </request>
    <response>
      <description>Returns a compact list of all recent emails with only the key fields.</description>
      <bash>
        [
          {
            "id": "[email_id]",
            "from": "[from name] - [from email]",
            "subject": "[email subject]",
            "date": "2023-10-01T12:34:56",
            "isUnread": true
          }
        ]
      </bash>
    </response>
  </command>

  <command>
    <trigger>Get Email Snippet</trigger>
    <request>
      <description>Fetch the snippet/preview of a specific email by its ID. Use this when the user wants a quick preview without loading the full body.</description>
      <bash>curl -X GET <GMAIL_GATEWAY_HOST>/api/emails/recent | jq '.data.emails[] | select(.id == "[email_id]") | {id, from, subject, date, snippet}'</bash>
    </request>
    <response>
      <description>Returns the snippet of the matched email.</description>
      <bash>
        {
          "id": "[email_id]",
          "from": "[from name] - [from email]",
          "subject": "[email subject]",
          "date": "2023-10-01T12:34:56",
          "snippet": "the email snippet or preview text"
        }
      </bash>
    </response>
  </command>

  <command>
    <trigger>Get Email Details</trigger>
    <request>
      <description>Fetch the full body of a specific email by its ID. The body is HTML — summarize or extract the relevant text for the user.</description>
      <bash>curl -X GET "<GMAIL_GATEWAY_HOST>/api/emails/message?id=[email_id]" | jq  '.data.emails[] | select(.id == "[email_id]") | {id, from, subject, date, body}'</bash>
    </request>
    <response>
      <description>Returns the HTML body of the specified email. Note: large HTML bodies may be truncated — extract the key content from what is returned.</description>
      <bash>
        {
          "id": "[email_id]",
          "from": "[from name] - [from email]",
          "subject": "[email subject]",
          "date": "2023-10-01T12:34:56",
          "body": "[HTML content of the email body]"
        }
      </bash>
    </response>
  </command>
</commands>