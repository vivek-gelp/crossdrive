import type { Metadata } from "next";
import Link from "next/link";
import { operator, OperatorStatement } from "../privacy/operator";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Terms of use" };

export default function Terms() {
  const op = operator();
  return (
    <article className="prose">
      <h1>Terms of use</h1>

      <h2>The service</h2>
      <OperatorStatement op={op} />
      <p>
        Only people the operator has allowed may sign in. By connecting an account you confirm that you are entitled to
        give an AI client access to it.
      </p>

      <h2>The software</h2>
      <p>
        Crossdrive is released under the{" "}
        <a href="https://github.com/vivek-gelp/crossdrive/blob/main/LICENSE">MIT licence</a> and is provided &quot;as
        is&quot;, without warranty of any kind. The authors are not liable for any claim, damages or other liability
        arising from its use. Any service level or support for this instance is a matter between you and its operator.
      </p>

      <h2>Your responsibility</h2>
      <ul>
        <li>An AI client acts on your instructions. Review dry-run previews before you apply changes.</li>
        <li>Follow the terms of Google, Microsoft and Dropbox, and of your AI client, when you use them through Crossdrive.</li>
        <li>Do not use Crossdrive to access accounts or data you are not authorised to access.</li>
      </ul>

      <h2>Safeguards</h2>
      <p>
        Crossdrive never permanently deletes files: deletion moves items to the provider&apos;s trash. Accounts can be
        set to read-only. Writes are recorded in an audit log and can be previewed and undone. Mail is draft-only unless
        sending is enabled for an account. These safeguards reduce risk; they do not remove it.
      </p>

      <h2>Ending use</h2>
      <p>
        You can stop at any time by disconnecting your accounts on <Link href="/connect">/connect</Link> and removing
        the connector from your AI client. See the <Link href="/privacy">privacy policy</Link> for how data is handled.
      </p>
    </article>
  );
}
