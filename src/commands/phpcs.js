import chalk from 'chalk';
import { execa } from 'execa';
import { access, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import inquirer from 'inquirer';
import { loadConfig } from '../utils/config-loader.js';
import { logger } from '../utils/logger.js';

// Global paths
const GLOBAL_COMPOSER_BIN = join(homedir(), '.composer/vendor/bin');
const GLOBAL_PHPCS = join(GLOBAL_COMPOSER_BIN, 'phpcs');
const GLOBAL_PHPCBF = join(GLOBAL_COMPOSER_BIN, 'phpcbf');
const GLOBAL_SECURITY_RULESET = join(homedir(), '.composer/phpcs-security.xml');
const GLOBAL_SNIFFS_PATH = join(homedir(), '.composer/vendor/woocommerce/woocommerce-sniffs');

/**
 * Check if file exists
 */
async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the phpcs binary path (checks global first, then local)
 */
async function getPhpcsBinary() {
  // Check global composer bin first
  if (await fileExists(GLOBAL_PHPCS)) {
    return GLOBAL_PHPCS;
  }

  // Check local vendor
  const localPath = join(process.cwd(), 'vendor/bin/phpcs');
  if (await fileExists(localPath)) {
    return localPath;
  }

  // Check if globally available in PATH
  try {
    await execa('phpcs', ['--version'], { timeout: 5000 });
    return 'phpcs';
  } catch {
    return null;
  }
}

/**
 * Get the phpcbf binary path
 */
async function getPhpcbfBinary() {
  if (await fileExists(GLOBAL_PHPCBF)) {
    return GLOBAL_PHPCBF;
  }

  const localPath = join(process.cwd(), 'vendor/bin/phpcbf');
  if (await fileExists(localPath)) {
    return localPath;
  }

  try {
    await execa('phpcbf', ['--version'], { timeout: 5000 });
    return 'phpcbf';
  } catch {
    return null;
  }
}

/**
 * Check if WooCommerce sniffs are available (global or local)
 */
async function hasWooCommerceSniffs() {
  // Check global first
  if (await fileExists(GLOBAL_SNIFFS_PATH)) {
    return true;
  }

  // Check local
  const localPath = join(process.cwd(), 'vendor/woocommerce/woocommerce-sniffs');
  return await fileExists(localPath);
}

/**
 * Get the security ruleset path
 */
async function getSecurityRuleset() {
  if (await fileExists(GLOBAL_SECURITY_RULESET)) {
    return GLOBAL_SECURITY_RULESET;
  }
  return null;
}

/**
 * Generate a default phpcs.xml file
 */
async function generatePhpcsConfig(config) {
  const textDomain = config.slug || 'my-plugin';
  const minWpVersion = '6.0';
  const phpVersion = '7.4-';

  const xmlContent = `<?xml version="1.0"?>
<ruleset name="WooCommerce Extension Coding Standards">
    <description>PHPCS ruleset for ${config.slug || 'WooCommerce extension'}</description>

    <!-- What to scan -->
    <file>.</file>

    <!-- Exclude paths -->
    <exclude-pattern>*/vendor/*</exclude-pattern>
    <exclude-pattern>*/node_modules/*</exclude-pattern>
    <exclude-pattern>*/.dist/*</exclude-pattern>
    <exclude-pattern>*/dist/*</exclude-pattern>
    <exclude-pattern>*/tests/*</exclude-pattern>
    <exclude-pattern>*/assets/*</exclude-pattern>
    <exclude-pattern>*/*.min.js</exclude-pattern>

    <!-- Configs -->
    <config name="minimum_supported_wp_version" value="${minWpVersion}" />
    <config name="testVersion" value="${phpVersion}" />

    <!-- Rules -->
    <rule ref="WooCommerce-Core" />

    <rule ref="WordPress.WP.I18n">
        <properties>
            <property name="text_domain" type="array" value="${textDomain}" />
        </properties>
    </rule>

    <rule ref="PHPCompatibility">
        <exclude-pattern>tests/</exclude-pattern>
    </rule>

    <!-- Allow short array syntax -->
    <rule ref="Generic.Arrays.DisallowShortArraySyntax.Found">
        <severity>0</severity>
    </rule>
</ruleset>
`;

  await writeFile(join(process.cwd(), 'phpcs.xml'), xmlContent, 'utf-8');
  logger.success('Created phpcs.xml');
}

/**
 * Run PHPCS command
 */
export async function phpcsCommand(options) {
  const title = options.full ? 'PHP CodeSniffer - Full WooCommerce Standards' : 'PHP CodeSniffer - Security Check';
  console.log(chalk.bold.cyan(`\n  ${title}\n`));

  // Check for phpcs binary
  const phpcs = await getPhpcsBinary();

  if (!phpcs) {
    logger.error('PHPCS not found');
    console.log();
    logger.info('Install globally via composer:');
    console.log(chalk.gray('  composer global require woocommerce/woocommerce-sniffs'));
    console.log();
    process.exit(1);
  }

  // Check for WooCommerce sniffs
  if (!await hasWooCommerceSniffs()) {
    logger.error('WooCommerce sniffs not installed');
    console.log();
    logger.info('Install globally via composer:');
    console.log(chalk.gray('  composer global require woocommerce/woocommerce-sniffs'));
    console.log();
    process.exit(1);
  }

  // Handle --fix option
  if (options.fix) {
    const phpcbf = await getPhpcbfBinary();
    if (!phpcbf) {
      logger.error('PHPCBF not found');
      process.exit(1);
    }
    return await runPhpcbf(phpcbf, options);
  }

  // Determine which standard/ruleset to use
  let standard = null;

  if (options.full) {
    // Use full WooCommerce-Core standard
    standard = 'WooCommerce-Core';
    console.log(chalk.gray('Using: WooCommerce-Core (full standards)\n'));
  } else {
    // Use security ruleset by default
    const securityRuleset = await getSecurityRuleset();
    if (securityRuleset) {
      standard = securityRuleset;
      console.log(chalk.gray('Using: Security ruleset (escaping, sanitization, SQL)\n'));
    } else {
      // Fallback to WooCommerce-Core if no security ruleset
      standard = 'WooCommerce-Core';
      console.log(chalk.gray('Using: WooCommerce-Core (security ruleset not found)\n'));
    }
  }

  // Build phpcs arguments
  const args = [];

  args.push(`--standard=${standard}`);
  args.push('--report=full');
  args.push('--colors');
  args.push('--extensions=php');

  // Show only errors (not warnings) if specified
  if (options.errorsOnly) {
    args.push('-n');
  }

  // File or directory to scan
  const target = options.path || '.';
  args.push(target);

  // Add exclusions (security ruleset has them built in, but add for CLI paths)
  if (options.path) {
    // No exclusions for specific path
  } else {
    args.push('--ignore=vendor/*,node_modules/*,dist/*,.dist/*,tests/*,assets/*');
  }

  try {
    const result = await execa(phpcs, args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      reject: false
    });

    console.log();

    if (result.exitCode === 0) {
      logger.success('No security issues found!');
      return { success: true, exitCode: 0 };
    } else if (result.exitCode === 1 || result.exitCode === 2) {
      logger.error('Security issues found');
      logger.info('Run with --fix to auto-fix some issues');
      return { success: false, exitCode: result.exitCode };
    } else {
      logger.error(`PHPCS exited with code ${result.exitCode}`);
      return { success: false, exitCode: result.exitCode };
    }
  } catch (error) {
    logger.error(`PHPCS failed: ${error.message}`);
    return { success: false, exitCode: 1 };
  }
}

/**
 * Run PHPCBF to auto-fix issues
 */
async function runPhpcbf(phpcbf, options) {
  console.log(chalk.yellow('Running PHPCBF to auto-fix issues...\n'));

  // Determine which standard to use
  let standard;
  if (options.full) {
    standard = 'WooCommerce-Core';
  } else {
    const securityRuleset = await getSecurityRuleset();
    standard = securityRuleset || 'WooCommerce-Core';
  }

  const args = [];
  args.push(`--standard=${standard}`);
  args.push('--extensions=php');

  const target = options.path || '.';
  args.push(target);

  if (!options.path) {
    args.push('--ignore=vendor/*,node_modules/*,dist/*,.dist/*,tests/*,assets/*');
  }

  try {
    const result = await execa(phpcbf, args, {
      cwd: process.cwd(),
      stdio: 'inherit',
      reject: false
    });

    console.log();

    if (result.exitCode === 0) {
      logger.success('No fixable issues found');
      return { success: true, exitCode: 0 };
    } else if (result.exitCode === 1) {
      logger.success('Fixed some issues');
      logger.info('Review the changes and run phpcs again');
      return { success: true, exitCode: 1 };
    } else if (result.exitCode === 2) {
      logger.warn('Some issues could not be auto-fixed');
      return { success: false, exitCode: 2 };
    } else {
      logger.error(`PHPCBF exited with code ${result.exitCode}`);
      return { success: false, exitCode: result.exitCode };
    }
  } catch (error) {
    logger.error(`PHPCBF failed: ${error.message}`);
    return { success: false, exitCode: 1 };
  }
}

/**
 * Run PHPCS as part of deploy/sync (non-interactive)
 * Returns true if passed, false if failed
 */
export async function runPhpcsCheck(options = {}) {
  const phpcs = await getPhpcsBinary();

  if (!phpcs) {
    if (options.skipIfMissing) {
      logger.warn('PHPCS not available, skipping security check');
      return true;
    }
    return false;
  }

  if (!await hasWooCommerceSniffs()) {
    if (options.skipIfMissing) {
      logger.warn('WooCommerce sniffs not installed, skipping security check');
      return true;
    }
    return false;
  }

  // Use security ruleset by default
  const securityRuleset = await getSecurityRuleset();
  const standard = securityRuleset || 'WooCommerce-Core';

  const args = [
    `--standard=${standard}`,
    // Decide pass/fail from real counts, not the exit code. PHPCS exits non-zero
    // for warnings too, and -n does not reliably demote them (it reports them in
    // the errors column instead), which used to fail the gate on warnings alone.
    '--report=json',
    // PHPCS prints a colored progress banner to stdout before the JSON payload,
    // which breaks JSON.parse. -q suppresses it; --no-colors drops ANSI escapes.
    '-q',
    '--no-colors',
    '--extensions=php',
    '--ignore=vendor/*,node_modules/*,dist/*,.dist/*,tests/*,assets/*',
    '.'
  ];

  try {
    const result = await execa(phpcs, args, {
      cwd: process.cwd(),
      reject: false
    });

    let totals;
    try {
      // Be tolerant of any preamble PHPCS may still emit before the JSON.
      const raw = result.stdout || '';
      totals = JSON.parse(raw.slice(raw.indexOf('{'))).totals;
    } catch {
      logger.error('Could not parse PHPCS output; treating as failure.');
      if (result.stdout) console.log(result.stdout.slice(0, 2000));
      return false;
    }

    const errors = totals?.errors ?? 0;
    const warnings = totals?.warnings ?? 0;
    const failed = options.errorsOnly ? errors > 0 : errors > 0 || warnings > 0;

    if (warnings > 0) {
      logger.warn(`PHPCS: ${warnings} warning(s)${options.errorsOnly ? ' (non-blocking)' : ''}`);
    }
    if (errors > 0) {
      logger.error(`PHPCS: ${errors} error(s)`);
    }

    return !failed;
  } catch (error) {
    logger.error(`PHPCS check failed: ${error.message}`);
    return false;
  }
}
