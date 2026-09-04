# Connecting the connector

The skill talks to one thing: the `do-09-tax-prep` MCP server, which holds the
workspace credential and does the work. No Google Drive connector is needed —
importing from a person's own Drive happens inside the server, through the
account they connected in the console.

The one thing another connector does here is **send** the finished pack. Reading,
searching or listing a mailbox is never part of this job.

## The endpoint — live

Either line works on its own. Use the header form where the client has a header
field; use the URL form where it does not.

```
https://do-09-tax-document-preparation-assi.vercel.app/api/mcp?key=m386rdPb0e3xWC7wJv6TpLAZkDCm3cAbDprJVwyGxQM=
```

```
URL:    https://do-09-tax-document-preparation-assi.vercel.app/api/mcp
Header: Authorization: Bearer m386rdPb0e3xWC7wJv6TpLAZkDCm3cAbDprJVwyGxQM=
```

## The Claude app

Settings → Connectors → **Add custom connector**. Paste either form above.

Then **start a new conversation.** A client binds the tool list when it connects,
so a session opened before the connector was added — or before the server last
changed — keeps serving the list it started with. If a tool the skill names is
missing, that is why: reconnect and open a fresh conversation rather than working
around it.

To confirm it took, ask it to list its `do-09-tax-prep` tools. **27** should come
back, including `upload_document` and `get_package`.

## Claude Code

```bash
claude mcp add --transport http do-09-tax-prep \
  "https://do-09-tax-document-preparation-assi.vercel.app/api/mcp" \
  --header "Authorization: Bearer m386rdPb0e3xWC7wJv6TpLAZkDCm3cAbDprJVwyGxQM="
```

Same caveat: restart the session afterwards, because tools are bound at start.

## Checking it

`GET /api/mcp` answers without a token and says whether the server is
configured. It never reveals whether a token you sent was right — a probe that
distinguished "wrong token" from "no token" would let somebody test guesses.

```bash
curl https://do-09-tax-document-preparation-assi.vercel.app/api/mcp
# {"name":"do-09-tax-prep","transport":"streamable-http","configured":true,...}
```

Then, with the token:

```bash
curl -s -X POST "https://do-09-tax-document-preparation-assi.vercel.app/api/mcp" \
  -H "Authorization: Bearer m386rdPb0e3xWC7wJv6TpLAZkDCm3cAbDprJVwyGxQM=" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400
```

## What the token protects

Everything. The tools read the whole register and include `delete_document`,
which removes a document, its reading, its categorisation and the file itself.
The token is the *only* thing in front of the workspace — the app's own HTTP
routes have no authentication of their own.

So the token above is a **shared demonstration credential**, and whoever holds it
can delete from the workspace it opens. It is not a per-person key and it is not
scoped down. Anyone standing up their own copy should set their own instead of
reusing this one.

## Your own deployment

`MCP_TOKEN` is a shared secret set in the deployment's environment. **Until it is
set the endpoint is closed and answers 503** — an unset variable fails shut
rather than open, because the alternative turns a forgotten setting into a
public `delete_document`.

```bash
openssl rand -base64 32
```

Set it wherever the app runs, redeploy, then use it in place of the token above.
Rotating is the same act: change the variable, redeploy, update the connector.

## Two Google connections, neither of them yours

Worth knowing when a Drive import fails, because the error will name one of
them:

- **The workspace connection** is the app's own server credential. It owns the
  shared folder where every workspace lives. It is set up once by whoever
  deploys the app.
- **The account connection** is per person: their own Drive, so they can import
  documents they already have. Each person grants it themselves from the
  console.

`connection_status` reports whether the second one exists and what it may do. No
mailbox-read permission is requested anywhere in this product.

The pack is sent by whoever is running the skill, using their own mail — not by
the deployment. `send_package` exists but routes through the deployment's own
Gmail credentials, which need the Gmail API enabled on its Google Cloud project;
where it is not, that call returns a 403 no amount of reconnecting fixes.
