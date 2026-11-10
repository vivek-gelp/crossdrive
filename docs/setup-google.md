# Set up Google Cloud

You create your own Google Cloud project and OAuth client. Crossdrive never ships a shared client, so Google treats the
app as yours and your tokens are issued to your own project. Allow about 15 minutes. You need a Google account; a
Google Workspace account is not required.

Throughout, `<BASE_URL>` is the public URL of your deployment, for example `https://my-crossdrive.vercel.app`, with no
trailing slash. If you have not deployed yet, you can create the client first and come back to add the redirect URIs
once you know the URL ([setup-vercel.md](setup-vercel.md)).

## 1. Create a project

1. Go to <https://console.cloud.google.com/> and sign in.
2. Open the project picker at the top left and choose **New project**.
3. Name it `crossdrive` (any name works), leave the organisation as is, and click **Create**.
4. Make sure the new project is selected in the picker.

[screenshot: new project dialog]

## 2. Enable the APIs

1. Open **APIs & Services**, then **Library**.
2. Search for **Google Drive API**, open it and click **Enable**.
3. Go back to the library, search for **Gmail API**, open it and click **Enable**.

[screenshot: both APIs shown as enabled]

## 3. Configure the OAuth consent screen

Open **APIs & Services**, then **OAuth consent screen** (in newer consoles this is **Google Auth Platform**, with
**Branding**, **Audience** and **Data Access** pages). The choices below are the same.

1. **User type.**
   - If every account you will connect belongs to one Google Workspace organisation, choose **Internal**. Nobody in the
     organisation sees an "unverified app" warning and tokens do not expire after 7 days. Internal only works for
     accounts of the organisation that owns the project.
   - If you will connect personal Gmail accounts, or accounts from several organisations, choose **External**.
   Mixed setups (for example a personal Gmail plus a company Workspace) need **External**, because Internal only admits
   its own organisation.
2. **App information.** App name `Crossdrive` (or anything), a support email (your own address), and your own email as
   developer contact. A logo is optional.
3. **App domain.** Google asks for homepage and privacy policy links before it lets you publish. Use
   `<BASE_URL>` for the homepage, `<BASE_URL>/privacy` for the privacy policy and `<BASE_URL>/terms` for the terms; your
   deployment serves those pages. Leaving them blank is accepted for Testing mode but may block publishing.
4. **Scopes.** Click **Add or remove scopes** and add these four (paste them into the "manually add scopes" box if the
   list does not show them):
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/gmail.send`

   Crossdrive also requests `openid` and `email` to learn which account signed in. If you only want Drive, you can
   omit the Gmail scopes; mail tools then report that Gmail is not granted.
5. **Test users (External only).** Add the email address of every Google account you will connect. You can skip this
   after publishing to Production, but it does no harm.

[screenshot: consent screen, user type choice]
[screenshot: scopes list with the four scopes]

## 4. Publish to Production (External apps)

An External app starts in **Testing** mode, where Google expires refresh tokens after 7 days. Your connections would
silently stop working every week. Fix this once:

1. On the consent screen page (or **Audience** in the new console), click **Publish app**.
2. Confirm. The status changes to **In production**.

You do not need to submit the app for verification to use it yourself. Google will show a warning screen at sign-in
(see the next section); that is expected for an unverified app you own. Internal apps skip this step; they are always
treated as published.

[screenshot: "In production" status]

## 5. Create the OAuth client

1. Open **APIs & Services**, then **Credentials**, then **Create credentials**, **OAuth client ID**.
2. **Application type:** Web application. Name it `crossdrive`.
3. **Authorised redirect URIs.** Add both of these exactly, with your real base URL:
   - `<BASE_URL>/api/google/callback` (used when you connect a Drive and Gmail account on `/connect`)
   - `<BASE_URL>/oauth/google-callback` (used when you sign in to an MCP client with Google)

   For local development also add `http://localhost:3000/api/google/callback` and
   `http://localhost:3000/oauth/google-callback`.
4. Click **Create**. Copy the **Client ID** and **Client secret**. These become `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` in Vercel. Treat the secret like a password; never commit it or paste it into a chat.

Google can take a few minutes to apply redirect URI changes.

[screenshot: client creation with both redirect URIs]

## 6. What you will see when you connect

- **Internal app:** a normal Google account chooser and consent screen.
- **External app, not verified:** "Google hasn't verified this app". Click **Advanced**, then **Go to
  Crossdrive (unsafe)**, then tick every permission box, including the Gmail ones. You see this once per account. It
  appears because you are the developer of an app Google has not reviewed; nobody else's data is involved.

[screenshot: unverified app warning with Advanced expanded]

## Troubleshooting

### "Access blocked: Crossdrive has not completed the Google verification process" (Error 403: access_denied)

The app is in Testing mode and the account you are signing in with is not on the test users list, or the app type is
External and unverified and the account is outside your project's allowed audience. Add the account under **Test
users**, or publish to Production (step 4). If the screen has no **Advanced** link at all, the account is probably
blocked by its organisation; see "Workspace admin blocking" below.

### "Error 400: redirect_uri_mismatch"

The redirect URI Crossdrive sent is not in the client's list. Open the client under **Credentials** and compare the
`redirect_uri` shown in the error details with your list. Common causes: a different scheme (`http` vs `https`), a
trailing slash, a preview-deployment URL instead of the production URL, or `CROSSDRIVE_BASE_URL` not matching the URL
you are browsing. Both `<BASE_URL>/api/google/callback` and `<BASE_URL>/oauth/google-callback` must be present. After
editing, wait a few minutes.

### Connections stop working after about 7 days

The consent screen is still in Testing mode. Publish it to Production (step 4), then reconnect each account once
from `/connect`; tokens issued earlier under Testing mode keep their 7-day limit.

### Workspace admin blocking the app

Workspace administrators can block unverified or third-party apps. If your organisation owns the project and you chose
**Internal**, this does not apply. If you used an External project against a company account, the admin must allow the
client: in the Admin console go to Security, Access and data control, API controls, App access control, and either mark
the app as trusted or allow it for the account's organisational unit, using your OAuth **Client ID**. Google's help page:
<https://support.google.com/a/answer/60757>.

### `invalid_grant`

Google refused to refresh a token. Typical causes: the account revoked access (in its Google security settings or via
a disconnect), the password changed on an account with Gmail scopes, the token was issued under Testing mode and is
older than 7 days, the app had 100 users while unverified, or the token was unused for six months. Reconnect the account
on `/connect`. The `status` tool reports which accounts currently have a working token.

### Gmail shows "not granted"

Google lets people untick individual permissions on the consent screen. Reconnect the account and tick every box. All
Gmail permissions you want to use must be granted.

### More reading

- Unverified apps and the 100-user cap: <https://support.google.com/cloud/answer/7454865>
- Restricted scope verification: <https://support.google.com/cloud/answer/13463817>
