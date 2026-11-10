# Google OAuth verification pack (hosted Crossdrive only)

Self-hosters do not need anything in this folder. If you run Crossdrive with your own Google Cloud project, you are the
developer and the only user, and you can leave the app unverified (see the README section on the unverified-app screen).

This pack exists for one future scenario: a **hosted** Crossdrive that other people sign in to using a Crossdrive-owned
Google OAuth client. That would make the project a public app requesting Drive and Gmail scopes, which Google reviews.

**Status of this document.** It is a planning aid written from public Google help pages and community reports, not from
a completed application. Google changes its process and fees; anything marked "unsure" must be checked against the
current pages before you rely on it. Nothing here is legal or compliance advice.

## Pages to read first

- Unverified apps and the user cap: <https://support.google.com/cloud/answer/7454865>
- Restricted scope verification (including the security assessment): <https://support.google.com/cloud/answer/13463817>
- Workspace admin app access control: <https://support.google.com/a/answer/60757>

## The process in outline

1. **Brand verification.** Google verifies the app name, logo, homepage, privacy policy and the ownership of the
   domains. Done in the Google Auth Platform branding page. Typically days to a couple of weeks (unsure; community
   reports vary).
2. **Scope review.** Each sensitive or restricted scope needs a written justification and a demo video. Google may ask
   follow-up questions, and each round adds days.
   - Sensitive scopes: reviewed against policy and the video. Which of our scopes are classed sensitive and which are
     restricted must be confirmed on Google's current scope list. As understood now, the full `drive` scope and the
     Gmail scopes (`gmail.modify`, `gmail.compose`, `gmail.send`) are **restricted** (unsure whether `gmail.send` or
     `gmail.compose` is classed restricted or sensitive; check).
3. **Security assessment for restricted scopes.** Apps with restricted scopes that store or transmit data on servers
   must pass an independent security assessment (CASA, the Cloud Application Security Assessment) by an authorised
   assessor, **annually** (unsure of the current tier requirements and whether a self-scan suffices at Crossdrive's
   level). Assessors charge fees (unsure of the amounts; budget for the possibility of several thousand US dollars per
   year) and require remediation of findings.
4. **Annual re-verification.** Letters of validation expire and must be renewed.

## Realistic timeline

If everything is ready (domain, policies, video, hardened deployment): brand verification and scope review may take
several weeks, and the security assessment adds weeks more, with remediation loops. Plan for **two to four months** end to
end for a first application, and treat anything faster as luck. (This is an estimate from community experience, not a
Google commitment.)

## While unverified

An unverified app can still be used, but Google caps it at **100 users over its lifetime** (new users added to the
consent screen count; the cap cannot be reset), shows the unverified warning to everyone, and in Testing mode expires
refresh tokens after 7 days. This is why Crossdrive is self-hosted today.

## Why this is not simply "do it now"

- It needs a legal entity or at least a person willing to be named publicly as operator, a dedicated domain and a
  privacy policy that matches the practice (Limited Use compliance for Google user data).
- A hosted version is multi-tenant. The current code is single-owner by design. See [open-questions.md](open-questions.md).
- The annual assessment is a recurring cost and workload for a volunteer project.

## Contents of this folder

- [requirements-checklist.md](requirements-checklist.md): what must exist before applying.
- [scope-justifications.md](scope-justifications.md): draft justification per scope.
- [demo-video-script.md](demo-video-script.md): script for the verification video.
- [open-questions.md](open-questions.md): multi-tenant work and unresolved questions.
