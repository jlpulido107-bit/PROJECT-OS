# Codex automated approved issues (pilot: PROJECT-OS only)

This workflow is **OFF by default**. It is committed for code review, not for immediate use.
It does not change the production dashboard, Google Sheets, the other two repos, or secrets.

## Scope and trigger

- Event: a new issue opened by jlpulido107-bit (including the dedicated dashboard PAT).
- Required issue title: [ORD-POS-NNN][POS-NNN] description.
- Required issue body marker: "aprobada por el propietario desde el dashboard de PROJECT-OS" and the existing objective/acceptance/out-of-scope sections.
- Extra gate: GitHub Actions repository variable CODEX_AUTOMATION_ENABLED must equal \`true\`.
- A preflight check skips orders that already have a PR or a Codex branch.
- This intentionally does **not** rely on @codex in issue comments: that is the legacy connector and may still emit a misleading "create an environment" comment until the dashboard's old mention is retired.
- Issues created **before activation are not backfilled**. Test with a fresh, substantive, explicitly approved order only.

## Security model

1. The Codex job checks out read-only GitHub credentials (persist-credentials: false), installs dependencies *before* Codex, and executes with the built-in :workspace permission profile and drop-sudo sandbox. Only the OpenAI API key is supplied to the Codex action.
2. The generated patch is treated as **untrusted** and is verified from a clean checkout in a separate job. Only ordinary source/test/docs paths are allowed. No binaries, symlinks, renames, workflows, secrets, configuration, deployment scripts or lockfiles.
3. Tests run without the API key or a GitHub write token.
4. A third job, **only after successful validation**, receives a write-scoped GitHub token to push the diff to a new codex/ord-pos-NNN branch and create a **draft PR**. Codex cannot merge or deploy.
5. Maximum 12 changed files, 160 KB patch, a 35-minute Codex job, and one run at a time per issue. These are resource controls, **not** an actual dollar hard cap.
6. Never configure allow-users: "*". Do not use pull_request_target with untrusted checkouts.

## Activation checklist — requires explicit owner approval

- [ ] Review and merge the PR adding this workflow (this proposal does NOT do that).
- [ ] In the OpenAI API platform, create a dedicated project, review current pricing, set a low project budget and usage alerts. Budgets/alerts might not hard-stop every charge; monitor usage.
- [ ] Create a **restricted, dedicated** API key with access required by Codex/Responses. Do not paste it into chat.
- [ ] Owner separately approves saving it in repository Actions secret named OPENAI_API_KEY. Do **not** save it until approved.
- [ ] Confirm GitHub Actions permissions allow creation of PRs via GITHUB_TOKEN; GitHub repo Settings > Actions > General, if required. Do not enable any setting without owner's approval.
- [ ] After an explicit owner go-ahead, set Actions variable CODEX_AUTOMATION_ENABLED=true, **last**. This is the production switch.
- [ ] Open one new, real low-risk order from the dashboard and review the Actions run / draft PR. Stop and disable the switch if checks fail.
- [ ] After pilot, remove the obsolete @codex issue-comment behavior from the dashboard in a separate reviewed change, then consider the other repos.

## Estimated API costs (USD; illustrative, not quotes)

As of October 2026, the listed *standard* API rates for gpt-5.3-codex are approximately
$1.75 / million input tokens and $14 / million output tokens before any cache savings.
At 200k input and 20k output tokens, that is ~$0.63.
At 500k input and 50k output tokens, ~$1.58.
Actual usage is task dependent; repeated agent tool/context turns can greatly change tokens.
GitHub Actions minutes on private repositories may also be charged under the user's plan.
Verify live pricing and billing **before** enabling. ChatGPT plan usage does not cover API billing.

## Operational constraints

- GitHub workflows on an issues.opened event require that the dashboard token be a PAT/app token that can trigger workflows; GITHUB_TOKEN-generated events usually do not trigger new workflows.
- The workflow does not mutate ORDENES_CODEX directly: existing PR discovery in the dashboard should register the draft PR using its [ORD-...] title. A PR existing does not automatically mean the order is completed or merged.
- The GitHub bot's PR may not trigger other pull_request workflows when created with GITHUB_TOKEN. The independent verify job always runs existing test commands before publishing.
- Approval/review/merge remains the owner's decision.
