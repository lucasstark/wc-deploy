import semver from 'semver';
import chalk from 'chalk';
import { execa } from 'execa';
import { loadConfig } from '../utils/config-loader.js';
import { logger } from '../utils/logger.js';
import { checkVersionConsistency } from '../utils/version-checker.js';
import { gitCommitOnly } from '../tasks/git-manager.js';
import { runBuild } from '../tasks/builder.js';
import { deployToWooCommerce } from '../tasks/deployer.js';
import { getDeployedVersion } from '../utils/deployed-version.js';
import { runPhpcsCheck } from './phpcs.js';
import { recordDeploy } from '../state/runs-store.js';

export async function deployCommand(options) {
  console.log(chalk.bold.cyan('\n  WooCommerce Extension Deployment\n'));

  const config = await loadConfig();

  logger.info(`Plugin: ${chalk.bold(config.slug || 'Unknown')}`);

  // Verify package.json, plugin file, and changelog versions all agree.
  const versionCheck = await checkVersionConsistency(config);
  if (!versionCheck.valid) {
    logger.error('Cannot deploy: version files are inconsistent.');
    logger.info('Update package.json, the plugin header, and changelog.txt so they all match, then re-run.');
    process.exit(1);
  }

  const version = versionCheck.version;

  // --assert-version is a check, not a target: error if it disagrees with the consistent version.
  if (options.assertVersion && options.assertVersion !== version) {
    logger.error(`Version mismatch: --assert-version ${options.assertVersion} does not match repo version ${version}`);
    logger.info('--assert-version asserts the version being deployed; it does not modify any files.');
    process.exit(1);
  }

  // Cross-check against what's already deployed on WooCommerce.com (informational + safety).
  if (config.productId) {
    const deployed = await getDeployedVersion(config.productId);
    if (deployed) {
      logger.info(`Deployed version: ${chalk.bold(deployed.version)} (${deployed.date})`);
      if (semver.lt(version, deployed.version)) {
        logger.error(`Local version ${version} is behind deployed version ${deployed.version}.`);
        process.exit(1);
      }
    } else {
      logger.info(`Deployed version: ${chalk.gray('unknown')}`);
    }
  }
  console.log();

  if (!options.skipPhpcs) {
    logger.step('Running PHPCS coding standards check...');
    const phpcsResult = await runPhpcsCheck({ skipIfMissing: true });

    if (!phpcsResult) {
      logger.error('PHPCS check failed - fix coding standards violations before deploying');
      logger.info('Run "wc-deploy phpcs" to see details, or "wc-deploy phpcs --fix" to auto-fix');
      logger.info('Or use --skip-phpcs to bypass this check');
      process.exit(1);
    }
    logger.success('PHPCS check passed');
    console.log();
  }

  const dryRun = options.dryRun || false;

  if (dryRun) {
    logger.info(chalk.yellow('\n📝 DRY RUN MODE - No changes will be made\n'));
  }

  try {
    if (!options.skipBuild) {
      logger.step('Building distribution package...');
      await runBuild(config, dryRun);
    } else {
      logger.info('Skipping build step');
    }

    // Commit any artifacts the build produced (POT, minified CSS, etc.). Skip if clean.
    if (!dryRun && await hasGitChanges()) {
      logger.step('Creating deploy candidate commit...');
      await gitCommitOnly(version, `Deploy version ${version}`, dryRun);
    } else if (dryRun) {
      logger.info(`Would commit build artifacts as "Deploy version ${version}"`);
    } else {
      logger.info('No build artifact changes to commit');
    }

    if (!options.skipDeploy) {
      logger.step('Deploying to WooCommerce.com...');
      const deployResult = await deployToWooCommerce(config, version, dryRun);

      if (deployResult && !dryRun) {
        await recordDeploy({
          slug: config.slug,
          version,
          productId: config.productId,
          cwd: process.cwd(),
          status: 'queued'
        });

        console.log(chalk.green.bold('\n✨ Deployment initiated!\n'));
        logger.info(`Tracked in ~/.wc-deploy/runs.json`);
        console.log();
        logger.info('Check status:');
        console.log(chalk.cyan('  wc-deploy monitor              ') + chalk.gray('# state-only, no network'));
        console.log(chalk.cyan('  wc-deploy monitor --refresh    ') + chalk.gray('# poll once'));
        console.log(chalk.cyan('  wc-deploy monitor --watch      ') + chalk.gray('# follow until terminal, notifies on completion'));
        console.log();
        logger.info('After deployment succeeds, tag and push:');
        console.log(chalk.cyan(`  git tag ${version}`));
        console.log(chalk.cyan('  git push && git push --tags'));

        process.exit(0);
      }
    } else {
      logger.info('Skipping WooCommerce.com deployment');
      logger.info('Tag manually when ready:');
      logger.info(`  git tag ${version}`);
      logger.info('  git push && git push --tags');
    }

    if (dryRun) {
      console.log();
      logger.info(chalk.yellow('This was a dry run. Run without --dry-run to apply changes.'));
    }
  } catch (error) {
    logger.error(`Deployment failed: ${error.message}`);
    process.exit(1);
  }
}

async function hasGitChanges() {
  try {
    const { stdout } = await execa('git', ['status', '--porcelain']);
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
