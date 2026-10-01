# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue.

Include the affected version, steps to reproduce and the impact. You will get an acknowledgement within a few days.

## Supported versions

Only the latest release receives fixes.

## Scope notes

- The server acts with the full permissions of the ZenMoney token it is given. Treat that token like a password; use `ZENMONEY_READ_ONLY=true` when write access is not needed.
- HTTP mode is single-user: anyone holding `MCP_HTTP_TOKEN` gets the same access. Keep it on loopback or a private network.
- The local snapshot cache contains your financial data (directory `0700`, file `0600`); disable it with `ZENMONEY_CACHE=off`.
