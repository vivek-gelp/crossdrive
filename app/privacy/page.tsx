import type { Metadata } from "next";
import Link from "next/link";
import { operator, OperatorStatement } from "./operator";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Privacy policy" };

const USER_DATA_POLICY = "https://developers.google.com/terms/api-services-user-data-policy";

export default function Privacy() {
  const op = operator();
  return (
    <article className="prose">
      <h1>Privacy policy</h1>

      <h2>Who runs this service</h2>
      <OperatorStatement op={op} />

      <h2>What Crossdrive does</h2>
      <p>
        Crossdrive lets an AI client that you have approved (for example Claude or ChatGPT) work with files and mail in
        the cloud accounts you connect to this instance. It only acts when that client calls one of its tools on your
        behalf.
      </p>

      <h2>Data it accesses</h2>
      <ul>
        <li>
          <strong>Google Drive:</strong> file and folder names, metadata, contents and sharing settings, to list, search,
          read, create, move, copy, rename, share and trash files.
        </li>
        <li>
          <strong>Gmail:</strong> messages, threads, labels and attachments, to search and read mail, create drafts,
          apply labels and, only if you enable it for an account, send mail.
        </li>
        <li>
          <strong>OneDrive and Dropbox (beta):</strong> file and folder names, metadata and contents, for the same file
          operations.
        </li>
        <li>
          <strong>Your sign-in:</strong> the email address of the account you sign in with, to check that you are
          allowed to use this instance.
        </li>
      </ul>
      <p>
        Data is fetched from the provider when a request needs it and returned to the AI client that asked. Crossdrive
        does not keep copies of files or messages.
      </p>

      <h2>Data it stores</h2>
      <ul>
        <li>OAuth refresh tokens for each connected account, encrypted (AES-256-GCM) in storage controlled by the operator.</li>
        <li>
          An audit log of actions that change something: time, client, account label, action, file or message ids and
          names, and for mail the recipients and subject. File contents and mail bodies are not logged.
        </li>
      </ul>
      <p>Short-lived access tokens are cached in memory and expire within an hour.</p>

      <h2>Sharing</h2>
      <p>
        Data is not sold, rented or shared with anyone, and is not used for advertising. It goes only to the AI client
        you connected, at its request. There are no analytics or tracking scripts on this site.
      </p>

      <h2>Google API Services: Limited Use</h2>
      <p>
        Crossdrive&apos;s use and transfer to any other app of information received from Google APIs will adhere to the{" "}
        <a href={USER_DATA_POLICY}>Google API Services User Data Policy</a>, including the Limited Use requirements.
      </p>
      <p>
        In particular, Google user data is used only to provide the file and mail features you request through your AI
        client; it is not transferred to others except as needed to provide those features, to comply with law, or as
        part of a merger or acquisition; it is not used for advertising; it is not used to develop, improve or train
        generalised AI or machine-learning models; and no person reads it except with your explicit agreement, when
        needed for security purposes such as investigating abuse, or to comply with applicable law.
      </p>

      <h2>Revoking access</h2>
      <ul>
        <li>
          Use <strong>Disconnect</strong> on <Link href="/connect">/connect</Link> to remove an account and delete its
          stored token.
        </li>
        <li>
          Remove the app from the provider&apos;s own permissions page:{" "}
          <a href="https://myaccount.google.com/permissions">Google</a>,{" "}
          <a href="https://account.live.com/consent/Manage">Microsoft</a> or{" "}
          <a href="https://www.dropbox.com/account/connected_apps">Dropbox</a>. This invalidates the stored token
          immediately.
        </li>
        <li>Remove the connector in your AI client to stop that client from calling Crossdrive.</li>
      </ul>

      <h2>Retention and deletion</h2>
      <p>
        Tokens are kept until you disconnect the account. Audit log entries are kept by the operator for as long as the
        instance runs, so that changes can be reviewed and undone; ask the operator to delete them.
      </p>
    </article>
  );
}
