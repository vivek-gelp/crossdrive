<!--
INDIE HACKERS  (Community, New post)
Angle: the build-and-testing story, not a launch announcement. About 500 words. No link in the opening;
the one link sits at the end, after the story has earned it.

Fields:
  Title:        I tested my open-source tool on real accounts before telling anyone. It broke three times.
  Group/topic:  Building in public (or the closest open-source / developer tools group available)
  Cover image:  optional; if used: https://vivek-gelp.github.io/crossdrive/brand/social-card.png
  Canonical:    Indie Hackers has no canonical field; the closing line names the canonical page:
                https://vivek-gelp.github.io/crossdrive/blog/several-google-accounts-with-claude.html

Paste the text BELOW the "-----8<-----" line. Stay in the thread for the first few hours and answer questions.
-->
-----8<-----
I have five Google accounts across several companies. When I started using Claude for file work, it could see one of them at a time. Others had the same problem: the most-reacted open request on Claude's connector tracker, as of November 2026, asks for exactly this, with 44 reactions and no staff reply since April.

So I built a small self-hosted server for myself. One URL, several Google Drive and Gmail accounts, each under a label I choose, so a path reads `work:/Projects/2026`. Search runs across every account and names any that failed. Folders copy between accounts. The safety rules live in code, not in a prompt: trash is the only delete, mail is draft-only by default, any account can be read-only, and every write is logged.

It worked for me. Whether it would work for anyone else was a different question.

**Testing before telling**

I decided not to tell anyone until it had survived real accounts: two personal Gmail accounts and one Workspace account in read-only mode, one deployment, the real consent screen in an unmodified Chrome. Four rounds. It broke three times in ways that mattered.

First, the consent screen could not be approved in Chrome at all. The page sent a no-referrer policy, so Chrome sent `Origin: null` when you pressed Approve, and my own server refused it. No client could connect.

Second, an account I had set to read-only received a temporary edit permission when I copied files out of it. The copy granted the destination account writer access to the source. Short-lived, but it broke the one promise "read-only" makes. Now read-only sources are streamed through the server and nothing is added to them.

Third, a mistyped argument created a folder in the wrong place. The tool silently ignored a parameter it did not recognise and fell back to the drive root. Now any unknown argument is refused with a "did you mean" hint.

All three are fixed in 1.0.1, and the fixes were observed on live Google accounts.

**What I took from it**

None of these bugs would have shown up in a demo. Each one came from an assumption I did not know I was making. If you are building something that touches people's files or mail, test it against real accounts in a real browser before you announce it, make the software refuse what it does not understand, and write down what you have not tested as plainly as what you have. My README has a "Not yet verified live" list, and OneDrive and Dropbox support sits on it as beta.

**What it costs a user**

Some effort: your own Google Cloud OAuth client, a Vercel deploy, and Google's "unverified app" notice for personal accounts. It covers Drive and Gmail only. For one account, the built-in connector is less work.

I wrote up the four ways to handle several Google accounts with Claude, including the ones that need no new software, here: https://vivek-gelp.github.io/crossdrive/blog/several-google-accounts-with-claude.html

The code is MIT licensed (github.com/vivek-gelp/crossdrive). If you try it and get stuck, open an issue and I will help.
