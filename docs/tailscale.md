# Tailscale remote access

Run Code Factory on a development machine such as `dev-host`, then use its bundled dashboard from a MacBook or phone through Tailscale Serve. The Manager keeps listening on `127.0.0.1:4310`; Serve provides HTTPS within your tailnet and proxies the dashboard, API, attachments, and live SSE events through one origin. Agent execution and workspace files stay on the Manager host or the Requirement's selected workspace.

## Prerequisites

- Install and connect [Tailscale](https://tailscale.com/download) on `dev-host` and each client device, including the phone. They must be in the same tailnet with access to the server.
- Use Tailscale 1.52 or newer for the commands below. Enable MagicDNS and [HTTPS certificates](https://tailscale.com/kb/1153/enabling-https) in the tailnet. Serve prints a setup link if required settings are missing.
- Follow the normal [Code Factory prerequisites](running-code-factory.md#prerequisites) on `dev-host`. The MacBook and phone only need Tailscale and a browser.
- Restrict tailnet access to `dev-host`'s Serve port to trusted operators using [Tailscale access controls](https://tailscale.com/docs/features/access-control). Manager has no application login or per-user permissions: anyone allowed to connect can operate its agents and workspaces. A default tailnet policy may allow all members, so membership alone is not a personal allowlist.

## Start on the development host

SSH to `user@dev-host` (replace both placeholders with your own username and hostname), then run these commands on **the development host** from the repository to manage:

~~~bash
cd /path/to/the/repository/to-manage
npx --package @luoyixin/code-factory code-factory-agent-manager start \
  --daemon --host 127.0.0.1 --port 4310

# Check the local backend before enabling the proxy.
curl --fail http://127.0.0.1:4310/api/health

# Inspect existing Serve listeners before choosing an HTTPS port.
tailscale serve status
tailscale serve --bg --https=443 http://127.0.0.1:4310
tailscale serve status
~~~

If Tailscale reports insufficient permission, run the Serve commands with `sudo` on the development host or ask its administrator to configure a Tailscale operator. Complete any HTTPS setup link printed by Serve and rerun the command.

If Manager is already running with different network options, run `code-factory-agent-manager restart --host 127.0.0.1 --port 4310` using the same installed package or `npx --package @luoyixin/code-factory code-factory-agent-manager restart --host 127.0.0.1 --port 4310`. Repeating daemon `start` does not change an existing daemon's options. For an existing foreground process, stop it in its terminal before starting the daemon.

Serve prints an address similar to:

~~~text
https://dev-host.example-tailnet.ts.net
|-- / proxy http://127.0.0.1:4310
~~~

Use the actual address printed for your tailnet. If port 443 already serves another application, choose an unused supported HTTPS port such as `--https=8443` and use the printed URL with `:8443`. Match that port in your tailnet access policy and shutdown command. Proxy at `/`: the dashboard uses root-relative assets and `/api` routes, so mounting it under a subpath such as `/code-factory` is unsupported.

## Open from the MacBook or phone

Connect Tailscale on the client device, then open the printed HTTPS URL in its browser. Use the full `*.ts.net` hostname for HTTPS. No SSH forwarding, public port forwarding, or client-side Code Factory installation is needed.

The bundled dashboard automatically connects to the URL you opened. Its API requests, attachment URLs, and SSE updates use the same origin. No CORS override is needed. If you previously saved a different Manager address for this browser origin, open the dashboard connection settings and set **HTTP URL** to the printed HTTPS URL; a saved address takes precedence over automatic selection.

Check the remote path from the MacBook while Tailscale is connected (replace the example hostname):

~~~bash
curl --fail https://dev-host.example-tailnet.ts.net/api/health
~~~

In the dashboard, verify that it reports an online connection, can create a TODO Requirement, and receives live updates. Repeat in the phone browser. Disable Tailscale on the client and verify that a fresh request cannot reach the private service.

## Access boundary and lifetime

Use **Serve** for tailnet-only access. **Funnel** publishes a service to the internet and is unsuitable for this unauthenticated Manager. Keep the Manager bound to loopback; do not open port 4310 on a public or LAN interface for this setup. Tailscale identity headers do not add an application login or limit what an allowed operator can do.

`--bg` keeps Serve configured after the SSH terminal closes and restores it when Tailscale restarts. The Manager daemon runs independently, and `code-factory-agent-manager stop` does not remove the Serve configuration. The Manager daemon does not automatically start after a host reboot; start it again or configure host-level service supervision separately.

Disable this listener on the development host with the flags used when enabling it:

~~~bash
tailscale serve --bg --https=443 off
tailscale serve status
~~~

This removes the selected HTTPS listener. Avoid `tailscale serve reset` on a machine with other Serve applications because it clears all Serve configuration.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Local `/api/health` fails | Check Manager status in the managed repository, its configured port, and daemon logs. |
| Local health works, remote URL does not | Check Tailscale connectivity on both devices, `tailscale serve status`, MagicDNS/HTTPS setup, and policy access to the chosen HTTPS port. |
| Proxy returns a backend connection error | Match the Serve target to Manager's loopback host and port; start Manager again after a reboot. |
| Dashboard attempts `127.0.0.1` or reports mixed content | Set its saved HTTP URL to the HTTPS Serve origin and use a build containing the remote-origin default fix. |
| Page loads but live updates stop | Ensure `/api/events` reaches the same proxy and any additional proxy streams SSE without buffering. |

Command behavior and setup requirements are documented in the official [Tailscale Serve guide](https://tailscale.com/docs/features/tailscale-serve) and [Serve CLI reference](https://tailscale.com/docs/reference/tailscale-cli/serve).
