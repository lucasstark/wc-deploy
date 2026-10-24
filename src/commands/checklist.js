import chalk from 'chalk';

const STEPS = [
  {
    title: 'Bump version',
    cmd: 'wc-deploy version 1.2.3 -m "Fix: ..."',
    note: 'Updates package.json, plugin header, and changelog.txt atomically.'
  },
  {
    title: 'Validate changelog format manually',
    note: "Open changelog.txt and eyeball the new entry — date, version line, indentation, bullets. Don't trust the auto-formatter."
  },
  {
    title: 'Check WP/WC compatibility headers',
    cmd: 'wc-deploy check',
    note: 'Shows the latest WP and WC versions to put in "Tested up to" headers.'
  },
  {
    title: 'Run local + remote security scan',
    cmd: 'wc-deploy security',
    note: 'PHPCS (local) + QIT security (remote). Errors fail the build; warnings are warnings.'
  },
  {
    title: 'Run QIT tests',
    cmd: 'wc-deploy qit --no-wait',
    note: 'Activation, API, PHPStan, etc. Use "wc-deploy qit <type> --no-wait" to run a single suite without blocking.',
    claudeNote: 'Pass --no-wait — the run is recorded into ~/.wc-deploy/runs.json and surfaces via "wc-deploy monitor". Do NOT block the main session waiting on QIT. Check status later with "wc-deploy monitor --refresh --json" and only escalate to the user on terminal failures (especially security).'
  },
  {
    title: 'Deploy',
    cmd: 'wc-deploy deploy --assert-version 1.2.3',
    note: 'Verifies versions match across the three files, builds, commits artifacts, uploads. Returns immediately; the run is tracked in ~/.wc-deploy/runs.json.',
    claudeNote: 'Always pass --assert-version <version>. Deploy returns as soon as the upload is queued — do NOT wait inline. The run is recorded; check progress with "wc-deploy monitor --refresh --json".'
  },
  {
    title: 'Watch for completion',
    cmd: 'wc-deploy monitor --watch',
    note: 'Polls every 30s, fires a macOS notification on terminal states (success, failure, security flag). No wall-clock timeout. Foreground only — Ctrl-C to stop.',
    claudeNote: 'For agent loops, prefer "wc-deploy monitor --refresh --json" on a schedule (e.g. /loop or /schedule) instead of --watch. Surface the user only when status is terminal-failed, security-failed, or all-success.'
  },
  {
    title: 'Tag and push (after deploy succeeds)',
    cmd: 'git tag 1.2.3 && git push && git push --tags',
    note: 'Run only after monitor reports success.'
  }
];

export async function checklistCommand() {
  console.log(chalk.bold.cyan('\n  Recommended Deployment Flow\n'));

  STEPS.forEach((step, idx) => {
    console.log(`${chalk.bold.green(`  ${idx + 1}.`)} ${chalk.bold(step.title)}`);
    if (step.cmd) {
      console.log(chalk.cyan(`     $ ${step.cmd}`));
    }
    console.log(chalk.gray(`     ${step.note}`));
    if (step.claudeNote) {
      console.log(chalk.yellow(`     [for Claude Code] ${step.claudeNote}`));
    }
    console.log();
  });

  console.log(chalk.gray('  Run "wc-deploy <command> --help" for flags on any step.\n'));
}
