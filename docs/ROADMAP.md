# Prioritized delivery plan

This plan is incremental. Preserve the existing evidence/review safeguards; measure whether each milestone improves an operator outcome.

| Priority | Work | Exit criterion |
|---|---|---|
| P0 • development foundation | Portable dependencies, state paths, browser configuration, executable launcher, clean import, onboarding docs and CI | Clean install + offline suite + local UI smoke are reproducible; actual missing integrations named |
| P0 • provider readiness | Verify supported model CLI/SDK route and worker schema; add authenticated non-business preflight, browser readiness and proxy-compatible HTTPS transport | One bounded model response and one permitted source request pass with recorded receipts; negative preflights block spending |
| P0 • assisted intake wizard | Business URL/manual fields, source excerpts and photo upload; generated evidence contract; preview gaps before Save | Operator prepares a valid real dossier without internal JSON; errors preserve entered work; upload sizes consistent across UI/API/storage |
| P0 • real proposal pilot | One operator-approved business, three opening studies, one complete private proposal | Real output reviewed at desktop/mobile; facts, primary conversion and assets checked; actual costs recorded; no automatic human approval |
| P1 • qualification workbench | Clear shortlist, evidence drawer, separate need/fit/contact/readiness, explicit next actions and duplicate merge | Each held lead has one actionable missing item; excluded leads never build; operator understands selection before spending |
| P1 • local provider adapter + import | CSV/manual importer, then one vetted local-data provider; optional Apollo enrichment | Fixed small cohort audited; source coverage, freshness, false positives and cost per qualified opportunity measured |
| P1 • usability and recovery | Simplify setup, persistent drafts, actionable stage errors, stale-evidence tasks, server pagination | Operators complete intake → review with keyboard and phone; stopped work never masquerades as success or consumes a new run on ambiguous replay |
| P1 • source/media flexibility | Owner-supplied assets with permission, separate redesign lane, configurable geography | Source-specific rules remain testable; no global text substitutions to broaden Houston qualification; rights are explicit |
| P2 • sales-to-delivery | Edit unsent outreach, approved sending integration, customer agreement, hosted private review, deployment adapter | Exact reviewed version delivered to a consenting customer; rollback, forms, domain ownership and support checklist verified |
| P2 • operations/economics | Token/provider cost ledger, backups and restore drill, maintenance plans and delivery monitoring | Known contribution margin; restored jobs/artifacts retain integrity; customer lead forms actually reach the business |
| Later • hosted product | Authentication, authorization, tenancy, secure queues, isolated workers, managed storage, audit/retention | Independent security/operations review before Internet exposure; local loopback assumptions explicitly replaced |

## First development sprint

1. Finish the GitHub import review and run CI.
2. Verify the model adapter; choose a supported route without guessing a model ID.
3. Implement the assisted intake wizard using the same service and existing validators.
4. Have the operator supply/approve one real business and permitted content; generate and review one real site.
5. Fix the demonstrated pilot blockers; then select a lead provider using the sourcing experiment.

These are ordered milestones, not delivery-date promises. No subscription, outreach, paid model run or customer publication occurred during this review.
