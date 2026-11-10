import { baseUrl, env } from "@/lib/config";

export type Operator = { name: string | null; contact: string | null; host: string };

/** Who runs this instance, from optional env. Shared by /privacy and /terms. */
export function operator(): Operator {
  const pick = (name: string) => env(name)?.trim() || null;
  let host = baseUrl();
  try {
    host = new URL(baseUrl()).host;
  } catch {
    // keep the raw value
  }
  return {
    name: pick("OPERATOR"),
    contact: pick("CONTACT"),
    host,
  };
}

function ContactLink({ contact }: { contact: string }) {
  const href = contact.includes("@") && !contact.includes("://") ? `mailto:${contact}` : contact;
  const linkable = href.startsWith("mailto:") || href.startsWith("https://") || href.startsWith("http://");
  return linkable ? <a href={href}>{contact}</a> : <>{contact}</>;
}

export function OperatorStatement({ op }: { op: Operator }) {
  if (!op.name && !op.contact) {
    return (
      <p>
        This instance of Crossdrive at <code>{op.host}</code> is operated by the person or organisation who deployed it.
        Crossdrive is open-source software; its authors do not run this instance and cannot see its data. The operator
        has not published contact details here, so direct questions to whoever gave you this address.
      </p>
    );
  }
  return (
    <p>
      This instance of Crossdrive at <code>{op.host}</code> is operated by {op.name ?? "the person who deployed it"}
      {op.contact ? (
        <>
          {" "}
          (contact: <ContactLink contact={op.contact} />)
        </>
      ) : null}
      . Crossdrive is open-source software; its authors do not run this instance and cannot see its data.
    </p>
  );
}
