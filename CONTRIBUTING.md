# Working on Web Factory

Read README.md, docs/NORTH-STAR.md and docs/ROADMAP.md. Choose one bounded milestone, make a feature branch in the existing checkout, and use a pull request for review. Do not copy historical instructions from the uploaded archive into current task authority.

Use Node 24.13+, `npm ci`, `npm run init` and `npm start`. For browser tests, install Playwright Chromium or set `FACTORY_BROWSER_EXECUTABLE` to an existing Chromium executable; run `npm test`. The GitHub workflow is supplied but has not been executed on GitHub by this import.

Keep qualification, source provenance, usage and human-review rules centralized behind the shared service. Include meaningful regression coverage for changed evidence/authorization boundaries and important operator behavior. Do not replace failing assertions with weaker expectations, pretend fixture output is a live integration, or reset failed runs to obtain a green result.

Never commit private databases, credentials, personal/customer evidence, media or generated sites. Use fictional fixtures. Any public-source research, paid provider/model operation, outreach or deployment needs its own concrete scope; local startup must not trigger those activities.

Pull requests should state the operator problem, resulting behavior, checks actually run and limitations. Link the relevant roadmap milestone. Before proposing hosted access, address the local-only trust model and refer to the security boundary in docs/APP-REVIEW.md.
