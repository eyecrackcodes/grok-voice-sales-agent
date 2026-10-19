# Run it on a server

This guide runs the bot in Docker on a small server, behind a reverse proxy that gives Twilio a public https address. If you only want to try it from your own computer, the tunnel steps in the README are enough.

## What you need

- A server with Docker and a domain name pointing at it.
- A reverse proxy that terminates https. The example below uses Caddy, which gets certificates on its own.
- Your `.env` file, filled in as described in the README.

## Build and start the container

From the project folder on the server:

```sh
docker build -t grok-voice-sales-agent .
docker run -d --name sales-agent --restart unless-stopped \
  --env-file .env \
  -e PUBLIC_BASE=https://bot.example.com \
  -e DASHBOARD_TOKEN=change-me-to-a-long-random-string \
  -v "$PWD/data:/app/data" \
  -p 127.0.0.1:4319:4319 \
  grok-voice-sales-agent
```

Three things in that command matter:

- `-p 127.0.0.1:4319:4319` publishes the container port on the server's loopback address only. The proxy on the same machine can reach it. Nothing else on the internet can.
- `DASHBOARD_TOKEN` is required. The image binds `0.0.0.0` inside the container, and the server refuses to start on a non-loopback address without a dashboard token.
- `-v "$PWD/data:/app/data"` keeps your leads file, call logs, outcomes and the encrypted vault when you rebuild the container. Keep `VAULT_KEY` the same across restarts, or saved SSN and bank details become unreadable.

`PUBLIC_BASE` must be the exact https address Twilio will call, with no trailing slash. The server checks every Twilio signature against it.

The image has no `.env` file in it. Pass settings with `--env-file`, or with `-e` for single values.

## Put a reverse proxy in front

### Option 1. Forward only what Twilio needs

Twilio needs four paths. Everything else, including the dashboard, stays unreachable from the internet.

```caddyfile
bot.example.com {
	@twilio path /twilio/inbound /twiml/whisper /twilio/amd /twilio-stream
	handle @twilio {
		reverse_proxy 127.0.0.1:4319
	}
	handle {
		respond 404
	}
}
```

Caddy upgrades the `/twilio-stream` WebSocket on its own, so no extra setting is needed. To use the dashboard, open an SSH tunnel from your computer, for example `ssh -L 4319:127.0.0.1:4319 you@your-server`, then browse to `http://127.0.0.1:4319/v2` and sign in with the token.

### Option 2. Forward the whole app

If you want the dashboard at the same address, forward everything:

```caddyfile
bot.example.com {
	reverse_proxy 127.0.0.1:4319
}
```

The dashboard token is then the only thing between the internet and your call transcripts, so make it long and random and share it with nobody. Option 1 is safer when you can live with an SSH tunnel.

## Point Twilio at it

- Outbound calls need nothing in the Twilio console. The server sends Twilio its instructions with each call.
- To let the bot answer calls to your number, set the number's voice webhook to `https://bot.example.com/twilio/inbound` with method POST, and turn on inbound calls in the settings. The route rejects any request without a valid Twilio signature.

## A tunnel works too

You can skip the domain, the proxy and the open server. Run the container the same way, then start a tunnel on the same machine that forwards to `127.0.0.1:4319`, for example `cloudflared tunnel --url http://127.0.0.1:4319`, and set `PUBLIC_BASE` to the https address it prints. The address changes each time a quick tunnel restarts, so a named tunnel with a fixed hostname is better for a number that takes inbound calls.

## Update, check and stop

```sh
git pull
docker build -t grok-voice-sales-agent .
docker rm -f sales-agent
# run the docker run command above again

docker logs -f sales-agent   # watch calls
docker stop sales-agent
```

Because `data/` is a mounted folder, the rebuild keeps your leads, call history and vault.

## Checklist before real calls

- `DASHBOARD_TOKEN` is set and the container port is published on `127.0.0.1` only.
- `PUBLIC_BASE` matches the address in your proxy exactly.
- `VAULT_KEY` is set and backed up somewhere other than this server.
- You hold consent for every number you dial. See `COMPLIANCE.md`.
