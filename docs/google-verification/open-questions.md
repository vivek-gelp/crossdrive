# Open questions for a hosted Crossdrive

Everything the current single-owner code does not do, and decisions that need an owner before applying for verification.

## Multi-tenant engineering

- **Tenant model.** Today one deployment has one owner and an allow-list of administrators. A hosted version needs users,
  each with their own set of accounts, and strict isolation of storage keys, audit logs and tokens per user.
- **Token storage.** One encrypted blob for a single owner does not scale or isolate. Options: per-user envelope keys
  with a managed KMS, or a database with row-level isolation. Key rotation and breach response need a plan.
- **Per-client consent.** The consent screen exists; in a multi-tenant app it must also be bound to the user, and the
  stateless JWT design must carry a tenant id.
- **Rate limits and quota.** Google API quota belongs to the Cloud project. One shared client means one user can exhaust
  quota for everyone; per-user limits and backoff are needed.
- **Abuse and cost.** Free signup invites abuse (cross-account copy, uploads from URLs). Decide limits, authentication
  strength and who pays for compute and storage.
- **Data deletion and export.** Users must be able to remove all data and revoke grants; the policy requires honouring
  it. Define retention for audit logs.
- **Observability without content.** Logging must stay free of file and mail content in a larger system with more
  tooling.
- **Support surface.** Hosted software needs on-call, status, and incident communication.

## Verification and compliance

- **Which scopes are restricted vs sensitive today** (unsure; check Google's list on the day of application).
- **Assessment tier and cost.** What level of CASA applies, which assessors, what it costs, and whether it is realistic
  for a volunteer project.
- **Limited Use compliance.** Confirm that no AI-generated or aggregated use of data conflicts with the policy. The
  product passes user data to the user's own chosen AI client at the user's request; confirm that this is permitted
  under the Google API Services User Data Policy, since policy language about AI/ML use has been tightening (unsure).
- **Operator identity.** Who is the legal operator, where is the privacy contact, and what jurisdiction applies?
- **Brand.** Confirm the Crossdrive name does not conflict with existing trademarks before using it on a consent screen.
- **Alternatives.** Drive-only hosted tier (avoiding Gmail restricted scopes) as a smaller first application; or
  `drive.file` plus a picker as a verification-light mode with reduced functionality.

## Product questions

- Is a hosted version wanted at all, given that self-hosting keeps tokens with the user? Interest should be measured
  from issues before committing to the cost.
- Should the hosted version exclude send and offer draft only?
- How does the hosted version handle OneDrive and Dropbox, whose own app review processes are separate?

## Suggested sequence if it goes ahead

1. Decide operator, domain and name; publish policies.
2. Build tenant isolation behind a feature flag; keep self-host mode unchanged.
3. Apply for brand verification and the Drive-only scope set first.
4. Add Gmail scopes in a second application once the first review succeeds.
