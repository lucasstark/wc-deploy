#!/usr/bin/env -S node --disable-warning=ExperimentalWarning

// Suppress dotenv v17 debug output
process.env.DOTENV_CONFIG_DEBUG = 'false';
process.env.DOTENV_CONFIG_SILENT = 'true';

import { program } from 'commander';
import chalk from 'chalk';
import { deployCommand } from '../src/commands/deploy.js';
import { versionCommand } from '../src/commands/version.js';
import { buildCommand } from '../src/commands/build.js';
import { statusCommand } from '../src/commands/status.js';
import { initCommand } from '../src/commands/init.js';
import { potCommand } from '../src/commands/pot.js';
import { minifyCommand } from '../src/commands/minify.js';
import { qitCommand, qitVersionCommand } from '../src/commands/qit.js';
import { phpcsCommand } from '../src/commands/phpcs.js';
import { securityCommand } from '../src/commands/security.js';
import { checkCommand } from '../src/commands/check.js';
import { checklistCommand } from '../src/commands/checklist.js';
import { monitorCommand } from '../src/commands/monitor.js';
import { e2eCommand, e2eListCommand } from '../src/commands/e2e.js';

program
  .name('wcm')
  .description('WooCommerce Marketplace CLI - Build and deploy WooCommerce extensions')
  .version('1.0.0');

// Init command
program
  .command('init')
  .description('Initialize a new .deployrc.json configuration file')
  .option('-f, --force', 'Overwrite existing config without prompting')
  .action(initCommand);

// Build command
program
  .command('build')
  .description('Build the distribution package (CSS minify, POT generation, zip)')
  .option('--dry-run', 'Simulate without making changes')
  .option('--skip-version-check', 'Skip version consistency check')
  .option('--use-builtin', 'Force use of built-in build tasks instead of buildCommand')
  .option('-f, --force', 'Continue even if version check fails')
  .action(buildCommand);

// POT command
program
  .command('pot')
  .description('Generate POT file for translations')
  .option('--dry-run', 'Simulate without making changes')
  .action(potCommand);

// Minify command
program
  .command('minify')
  .description('Minify CSS files only (no POT, no zip)')
  .option('--dry-run', 'Simulate without making changes')
  .action(minifyCommand);

// PHPCS command
program
  .command('phpcs')
  .description('Run PHP CodeSniffer security check (escaping, sanitization, SQL)')
  .option('--fix', 'Auto-fix issues using PHPCBF')
  .option('--full', 'Use full WooCommerce-Core standards instead of security-only')
  .option('--errors-only', 'Show only errors, not warnings')
  .option('--path <path>', 'Specific file or directory to scan')
  .action(phpcsCommand);

// Security command (PHPCS + QIT security)
program
  .command('security')
  .description('Run local PHPCS security check, then QIT remote security scan')
  .option('--skip-build', 'Skip build step before QIT test')
  .option('--skip-phpcs', 'Skip the local PHPCS gate and go straight to the remote QIT scan')
  .option('--verbose', 'Show detailed output')
  .action(securityCommand);

// QIT command
program
  .command('qit [testType]')
  .description('Run QIT tests or check deployed version. Use "qit version" to check WooCommerce.com, or test types: security, activation, api, e2e, phpstan, all')
  .option('--skip-build', 'Skip build step before running tests')
  .option('--no-wait', 'Do not wait for test results')
  .option('--verbose', 'Show full test output (or show recent changelog for version)')
  .option('--continue-on-error', 'Continue running tests even if one fails')
  .option('--ignore <plugins>', 'Ignore plugin dependencies (comma-separated)')
  .option('--raw', 'Output raw JSON (for version command)')
  .action((testType, options) => {
    if (testType === 'version') {
      return qitVersionCommand(options);
    }
    return qitCommand(testType, options);
  });

// Check command
program
  .command('check')
  .description('Fetch and display latest WordPress and WooCommerce versions')
  .action(checkCommand);

// Checklist command
program
  .command('checklist')
  .description('Print the recommended deployment workflow')
  .action(checklistCommand);

// E2E command
program
  .command('e2e [subcommand]')
  .description('Run E2E tests using QIT test packages (activation, ciab, performance)')
  .option('--package <name>', 'Test package: activation, ciab, performance', 'activation')
  .option('--skip-build', 'Skip building zip before testing')
  .option('--ui', 'Run tests with visible browser')
  .option('--debug', 'Enable debug mode')
  .action((subcommand, options) => {
    if (subcommand === 'list') {
      return e2eListCommand();
    }
    return e2eCommand(options);
  });

// Version command
program
  .command('version [newVersion]')
  .description('Update version numbers. Interactive prompt if no version specified.')
  .option('--dry-run', 'Simulate without making changes')
  .option('-f, --force', 'Skip sanity checks and prompts')
  .option('-m, --message <entry>', 'Changelog entry (can be used multiple times)', (val, acc) => { acc.push(val); return acc; }, [])
  .action(versionCommand);

// Deploy command
program
  .command('deploy')
  .description('Build and deploy to WooCommerce.com. Versions in package.json, plugin file, and changelog.txt must already match.')
  .option('--assert-version <version>', 'Assert the version being deployed (errors if it does not match the repo). Recommended for scripted/agent use.')
  .option('--skip-phpcs', 'Skip PHPCS coding standards check')
  .option('--skip-build', 'Skip build step')
  .option('--skip-deploy', 'Skip deployment to WooCommerce.com')
  .option('--dry-run', 'Simulate without making changes')
  .action(deployCommand);

// Status command
program
  .command('status')
  .description('Check WooCommerce.com deployment status (one-shot, current dir only)')
  .action(statusCommand);

// Monitor command - tracks all in-flight runs across extensions
program
  .command('monitor')
  .description('List/poll/follow tracked deploy + QIT runs (state at ~/.wc-deploy/runs.json)')
  .option('--refresh', 'Poll the cloud for non-terminal runs and update state')
  .option('--watch', 'Loop refresh until everything terminal; notifies on completion')
  .option('--json', 'Output runs as JSON')
  .option('--purge', 'Remove terminal entries from state')
  .option('--purge-all', 'Remove ALL entries from state')
  .action(monitorCommand);

// Handle unknown commands
program.on('command:*', function () {
  console.error(chalk.red(`\nInvalid command: ${program.args.join(' ')}`));
  console.log(chalk.yellow('\nAvailable commands:'));
  console.log(chalk.cyan('  init       ') + chalk.gray('Initialize .deployrc.json'));
  console.log(chalk.cyan('  build      ') + chalk.gray('Build distribution package'));
  console.log(chalk.cyan('  pot        ') + chalk.gray('Generate POT file'));
  console.log(chalk.cyan('  phpcs      ') + chalk.gray('Run PHP CodeSniffer with WooCommerce standards'));
  console.log(chalk.cyan('  security   ') + chalk.gray('Local PHPCS + QIT remote security scan'));
  console.log(chalk.cyan('  qit        ') + chalk.gray('Run QIT tests (use "qit version" to check deployed version)'));
  console.log(chalk.cyan('  check      ') + chalk.gray('Fetch latest WordPress and WooCommerce versions'));
  console.log(chalk.cyan('  checklist  ') + chalk.gray('Print the recommended deployment workflow'));
  console.log(chalk.cyan('  e2e        ') + chalk.gray('Run E2E tests (use "e2e list" to see packages)'));
  console.log(chalk.cyan('  version    ') + chalk.gray('Update version numbers'));
  console.log(chalk.cyan('  deploy     ') + chalk.gray('Full deployment workflow'));
  console.log(chalk.cyan('  status     ') + chalk.gray('Check deployment status (one-time, current dir)'));
  console.log(chalk.cyan('  monitor    ') + chalk.gray('List/poll/follow tracked deploy + QIT runs'));
  console.log(chalk.yellow('\nSee --help for more details.\n'));
  process.exit(1);
});

program.parse();
