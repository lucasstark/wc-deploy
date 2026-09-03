import chalk from 'chalk';
import { loadConfig } from '../utils/config-loader.js';
import { logger } from '../utils/logger.js';
import { minifyCssFiles } from '../tasks/css-minifier.js';

/**
 * Minify CSS files only — no POT regeneration, no zip.
 *
 * `build` does all three, which makes it the wrong tool for the one thing you
 * do while writing CSS. This is that step on its own.
 */
export async function minifyCommand(options) {
  console.log(chalk.bold.cyan('\n  Minifying CSS\n'));

  const config = await loadConfig();

  if (config.minifyCss === false) {
    logger.warn('minifyCss is disabled in .deployrc.json — nothing to do.');
    return;
  }

  try {
    await minifyCssFiles(config, options.dryRun);
    console.log();
  } catch (error) {
    logger.error(`CSS minification failed: ${error.message}`);
    process.exit(1);
  }
}
