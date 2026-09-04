# Connecting the connector

The skill talks to one thing: the `do-09-tax-prep` MCP server, which the app
serves at `/api/mcp`. Nothing else needs attaching — no Google Drive connector,
no Gmail connector. The server holds the workspace credential and does the work.

## The endpoint

```
https://<your-deployment>/api/mcp
Authorization: Bearer <MCP_TOKEN>
```

`MCP_TOKEN` is a shared secret you set in the deployment's environment. **Until
it is set the endpoint is closed and answers 503** — an unset variable fails
shut rather than open, because the alternative turns a forgotten setting into a
public `delete_document`.

Generate one and set it wherever the app runs:

```bash
openssl rand -base64 32
```

For clients that cannot send headers, `?key=<MCP_TOKEN>` on the URL works too.

## Claude Code

```bash
claude mcp add --transport http do-09-tax-prep \
  https://<your-deployment>/api/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

## The Claude app

Settings → Connectors → **Add custom connector**, with the URL above. Where the
client offers a header field, use `Authorization: Bearer <MCP_TOKEN>`; where it
does not, put the token in the URL as `?key=`.

## Checking it

`GET /api/mcp` answers without a token and says whether the server is
configured. It never reveals whether a token you sent was right — a probe that
distinguished "wrong token" from "no token" would let somebody test guesses.

```bash
curl https://<your-deployment>/api/mcp
# {"name":"do-09-tax-prep","transport":"streamable-http","configured":true,...}
```

Then, with the token:

```bash
curl -s -X POST https://<your-deployment>/api/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 400
```

## What the token protects

Everything. The tools read the whole register and include `delete_document`,
which removes a document, its reading, its categorisation and the file itself.
Treat the token like a password: one per deployment, rotated by changing the
variable and redeploying, and never pasted anywhere shared.

The token is the *only* thing standing in front of the workspace — the app's own
HTTP routes have no authentication of their own.

## Two Google connections, neither of them yours

Worth knowing when a Drive import fails, because the error will name one of
them:

- **The workspace connection** is the app's own server credential. It owns the
  shared folder where every workspace lives. It is set up once by whoever
  deploys the app.
- **The account connection** is per person: their own Drive, so they can import
  documents they already have, and their own address, so a finished package can
  be sent from it. Each person grants it themselves from the console.

`connection_status` reports whether the second one exists and what it may do. No
mailbox-read permission is requested anywhere in this product.
