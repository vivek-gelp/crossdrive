# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories: open the repository's **Security** tab and
choose **Report a vulnerability**. Do not open a public issue or pull request for a security problem.

Include what you found, how to reproduce it, the version, and the impact you expect. Do not include real tokens or other
people's data; redact identifiers.

You can expect an acknowledgement within a few days. This is a volunteer project, so fix times vary with severity and
maintainer availability. We will tell you when a fix is released and credit you if you wish.

## Supported versions

Only the latest release receives security fixes.

## Scope

In scope: the code in this repository, including the OAuth server, token storage, the safety gates (read-only mode, mail
modes, recipient allowlist), the audit log and the connect pages.

Out of scope: your own deployment's configuration (weak secrets, a leaked Vercel account), Google, Microsoft, Dropbox or
Vercel themselves, and findings that require an attacker to already hold your environment variables.

## Hardening your deployment

See [docs/security.md](docs/security.md). In short: keep the allow-list short, use read-only mode where writes are not
needed, publish your Google app to Production, enable two-factor authentication on Vercel and GitHub, and rotate
`CROSSDRIVE_JWT_SECRET` if you suspect a leak.
