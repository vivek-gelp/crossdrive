# Requirements checklist

Check every item against Google's current requirements before applying; items marked (unsure) are inferred.

## Domain and public pages

- [ ] A domain owned by the operator, used for the hosted app (not a shared platform domain such as a free hosting
      subdomain; unsure whether Google accepts those for restricted scopes, assume not).
- [ ] The domain verified in Google Search Console by the same Google account that owns the Cloud project (or a
      project owner/editor).
- [ ] Homepage on that domain that describes the app, links to the privacy policy and is not just a login page.
- [ ] Privacy policy on that domain that names the app, lists the Google data accessed and why, how it is stored
      (encrypted refresh tokens only; no file or mail content is stored), who can access it, retention and deletion, and
      how users revoke access.
- [ ] Terms of service on that domain.
- [ ] In-app disclosure of Google API Services User Data Policy Limited Use compliance (unsure of the exact wording
      required; Google's policy page gives it), shown on the homepage and privacy policy, ideally also before consent.
- [ ] A support contact that works.

## Project configuration

- [ ] Dedicated Google Cloud project (not shared with other apps), correct app name matching the homepage.
- [ ] Authorised domains and redirect URIs on the hosted domain only.
- [ ] Minimum scopes only (see [scope-justifications.md](scope-justifications.md)); remove any scope not used.
- [ ] Consent screen branding: logo, name, support email, developer contact email monitored by the team.
- [ ] Publishing status set to In production when applying.

## Evidence

- [ ] Demo video on YouTube (unlisted) following [demo-video-script.md](demo-video-script.md).
- [ ] Written scope justifications, one per scope.
- [ ] Description of how data is stored and protected (AES-256-GCM tokens, no content stored, audit log without bodies).

## Security assessment (restricted scopes)

- [ ] Choose an authorised assessor from Google's current list (unsure of the list; Google publishes it).
- [ ] Budget, owner and schedule for yearly renewal.
- [ ] Threat model and penetration-style review of the deployment ([../security.md](../security.md) is the starting
      point).
- [ ] Vulnerability disclosure channel (SECURITY.md) and incident response plan.

## Product work required (see open-questions.md)

- [ ] Multi-tenant storage and isolation.
- [ ] Per-user consent, data deletion and export.
- [ ] Rate limiting and abuse controls.
