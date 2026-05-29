# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities through GitHub's private vulnerability
reporting: go to the **Security** tab of this repository and click
**"Report a vulnerability"**. This opens a private advisory visible only to the
maintainer.

Do not open a public issue for security reports.

You will receive an acknowledgement, and confirmed issues will be prioritized for a fix.

## Scope

Wren is a client-side PWA that uses Google OAuth (token model) to sync notes to
your own Google Drive. There is no server and no stored client secret. Reports
most relevant to Wren: OAuth scope/redirect handling, token storage in the
browser, and any data exposure in the sync logic.
