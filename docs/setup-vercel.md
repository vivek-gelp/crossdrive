# Deploy to Vercel

You need a Vercel account (the free Hobby plan is enough for personal use; check Vercel's current limits for function
duration) and a Google OAuth client from [setup-google.md](setup-google.md).

## 1. Generate the two secrets

`CROSSDRIVE_JWT_SECRET` signs OAuth artefacts. `CROSSDRIVE_ENC_KEY` encrypts stored refresh tokens and must be 32 random
bytes, base64 encoded. Generate each separately; never reuse one value for both.

```bash
openssl rand -base64 32
```

or, with Node:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep a copy of `CROSSDRIVE_ENC_KEY` in a password manager. If you lose it, stored tokens cannot be decrypted and you have
to reconnect every account. Rotating `CROSSDRIVE_JWT_SECRET` instead signs out every MCP client (a useful emergency
brake).

## 2. Deploy

1. Click the **Deploy with Vercel** button in the [README](../README.md), or import the repository in the Vercel
   dashboard (Add New, Project).
2. When asked for environment variables, fill in:

   | Name | Value |
   |---|---|
   | `GOOGLE_CLIENT_ID` | from Google Cloud |
   | `GOOGLE_CLIENT_SECRET` | from Google Cloud |
   | `CROSSDRIVE_JWT_SECRET` | generated above |
   | `CROSSDRIVE_ENC_KEY` | generated above |
   | `CROSSDRIVE_ALLOWED_EMAILS` | comma-separated Google emails allowed to sign in and administer, for example `you@example.com` |
   | `CROSSDRIVE_BASE_URL` | the deployment URL, no trailing slash; you may not know it yet, see step 4 |

3. When the clone flow offers a **Blob** store, create it. If it does not, do it in step 3 below.

## 3. Create the Blob store

Crossdrive keeps encrypted tokens and the audit log in Vercel Blob. In the Vercel dashboard open your project, go to
**Storage**, **Create**, **Blob**, and create a store with **private** access. Connect it to the project for all
environments. This adds `BLOB_READ_WRITE_TOKEN` automatically. The store lives in your Vercel account; nobody else has
access to it.

Without a Blob token (for example on your laptop) the app uses an in-memory store and forgets everything on restart.

## 4. Set the base URL, then redeploy

1. Note your production URL, for example `https://my-crossdrive.vercel.app`. A custom domain is fine and is cleaner for
   the Google consent screen.
2. Set `CROSSDRIVE_BASE_URL` to it under Settings, Environment Variables.
3. In Google Cloud add the two redirect URIs `<BASE_URL>/api/google/callback` and `<BASE_URL>/oauth/google-callback`
   to the OAuth client.
4. Redeploy (Deployments, the latest one, Redeploy) so the new variables take effect. Environment variable changes never
   apply to existing deployments.

Optional variables are described in the [README configuration table](../README.md#configuration) and in
`.env.example`.

## 5. First visit

1. Open `<BASE_URL>/setup`. It is a checklist showing which required variables are present (under their `CROSSDRIVE_`
   names; the legacy `VAULT_` names also count), whether a Blob store token is set, whether the secrets have the right
   length and whether the base URL matches the address you opened. Fix anything marked fail and redeploy.
2. Open `<BASE_URL>/connect`. Sign in with an email from `CROSSDRIVE_ALLOWED_EMAILS`.
3. Add your first account: type a label (lowercase letters, digits and hyphens, starting with a letter, up to 24
   characters, such as `work`), optionally the account's email to pre-select it, and click **Connect Google**. Tick
   every permission. A new account starts as read + write with mail mode `draft`; switch it to read-only or change the
   mail mode (`off`, `draft` or `send`) on its card afterwards.
4. Repeat for each Google account. Use **Reconnect** if a token expires, **Disconnect** to remove an account and
   revoke its token at Google, and **Disconnect everything** to revoke all of them at once.
5. Add `<BASE_URL>/api/mcp` to your AI client ([README](../README.md#connecting-clients)).

## Local development

```bash
pnpm install
cp .env.example .env.local   # fill in values; CROSSDRIVE_BASE_URL=http://localhost:3000
pnpm dev
```

Add `http://localhost:3000/api/google/callback` and `http://localhost:3000/oauth/google-callback` to the Google client.

## Optional: OneDrive and Dropbox (BETA)

OneDrive and Dropbox support is beta and has not yet been tested against live accounts. To try it, register an app with
Microsoft and/or Dropbox as described in [providers.md](providers.md), set `MS_CLIENT_ID` and `MS_CLIENT_SECRET`
(optionally `MS_TENANT`) and/or `DROPBOX_CLIENT_ID` and `DROPBOX_CLIENT_SECRET`, and register the redirect URIs
`<BASE_URL>/connect/microsoft/callback` and `<BASE_URL>/connect/dropbox/callback` with those apps. After a redeploy,
`/connect` shows **Connect Microsoft** and **Connect Dropbox** buttons and `/setup` lists the two redirect URIs.

## Updating

Pull the latest changes into your repository copy and let Vercel redeploy. Read `docs/CHANGELOG.md` first; any change
to environment variables or redirect URIs is listed there.

## Troubleshooting

- `/setup` says the Blob store is missing: the store is not connected to this environment; connect it and redeploy.
- Everyone gets signed out after a deploy: `CROSSDRIVE_JWT_SECRET` changed. Keep it stable.
- "Gmail not granted" or "token invalid" for an account: reconnect it on `/connect`. See the Google troubleshooting
  section for `invalid_grant`.
