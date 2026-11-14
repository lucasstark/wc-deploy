import { mkdir, rm, cp, readdir, stat, writeFile } from 'fs/promises';
import { join, basename } from 'path';
import { createWriteStream, createReadStream } from 'fs';
import archiver from 'archiver';
import { logger } from '../utils/logger.js';

const DEFAULT_EXCLUDE = [
  // Build/dev folders
  'node_modules',
  'dist',
  'tests',
  'test',
  'grunt',
  'build',
  // Config/lock files
  'phpcs.xml',
  'phpcs.xml.dist',
  'composer.json',
  'composer.lock',
  'package.json',
  'package-lock.json',
  'Gruntfile.js',
  'gulpfile.js',
  'webpack.config.js',
  // Documentation
  'README.md',
  'readme.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'LICENSE.md',
  // Misc
  'Thumbs.db'
];

// Patterns that use glob syntax (separate for proper handling)
const GLOB_EXCLUDE = [
  '*.map',
  '*.old'
];

/**
 * Convert a simple glob pattern to regex
 * Properly escapes special regex characters except *
 */
function globToRegex(pattern) {
  // Escape all special regex chars except *
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  // Convert * to .*
  const regexStr = escaped.replace(/\*/g, '.*');
  return new RegExp('^' + regexStr + '$');
}

/**
 * Check if file/directory should be excluded
 */
function shouldExclude(path, excludeList) {
  const fullExclude = [...DEFAULT_EXCLUDE, ...(excludeList || [])];
  const globPatterns = [...GLOB_EXCLUDE, ...(excludeList || []).filter(p => p.includes('*'))];
  const itemName = basename(path);

  // Always exclude dotfiles (files/folders starting with .)
  if (itemName.startsWith('.')) {
    return true;
  }

  // Check exact matches first
  if (fullExclude.some(pattern => {
    if (pattern.includes('*')) return false; // Skip glob patterns here
    return itemName === pattern || path.includes(`/${pattern}/`) || path.endsWith(`/${pattern}`);
  })) {
    return true;
  }

  // Check glob patterns
  return globPatterns.some(pattern => {
    const regex = globToRegex(pattern);
    return regex.test(itemName);
  });
}

/**
 * List the files that ship in the distribution zip, relative to root.
 * Uses the same exclusion rules as the zip itself.
 */
export async function listShippedFiles(root, excludeList = [], prefix = '') {
  const files = [];
  const entries = await readdir(join(root, prefix), { withFileTypes: true });

  for (const entry of entries) {
    const relPath = join(prefix, entry.name);

    if (shouldExclude(join(root, relPath), excludeList)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...await listShippedFiles(root, excludeList, relPath));
    } else {
      files.push(relPath);
    }
  }

  return files;
}

/**
 * Build distribution zip file
 */
export async function buildDistributionZip(config, version, dryRun = false) {
  const slug = config.slug;
  const distPath = join(process.cwd(), config.distPath || './dist');
  const tempPath = join(distPath, 'temp', slug);
  const zipPath = join(distPath, `${slug}.zip`);

  if (dryRun) {
    logger.info(`Would create zip: ${zipPath}`);
    return { success: true, zipPath, dryRun: true };
  }

  const spinner = logger.spinner('Building distribution package...');

  try {
    // Clean and create directories
    logger.info('Cleaning dist directory...');
    await rm(distPath, { recursive: true, force: true });
    await mkdir(tempPath, { recursive: true });

    // Copy files to temp directory
    await copyDirectory(process.cwd(), tempPath, config.exclude || []);

    // Create zip file
    await createZip(tempPath, zipPath, slug);

    // Clean up temp
    await rm(join(distPath, 'temp'), { recursive: true, force: true });

    spinner.succeed(`Distribution package created: ${basename(zipPath)}`);

    return { success: true, zipPath };
  } catch (error) {
    spinner.fail('Failed to create distribution package');
    throw new Error(`Zip build failed: ${error.message}`);
  }
}

/**
 * Copy directory recursively, excluding specified patterns
 */
async function copyDirectory(src, dest, excludeList = []) {
  await mkdir(dest, { recursive: true });

  const entries = await readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    // Skip excluded files/directories
    if (shouldExclude(srcPath, excludeList)) {
      continue;
    }

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath, excludeList);
    } else {
      await cp(srcPath, destPath);
    }
  }
}

/**
 * Create zip archive
 */
async function createZip(sourceDir, outputPath, baseName) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(outputPath);
    const archive = archiver('zip', {
      zlib: { level: 9 }
    });

    output.on('close', resolve);
    archive.on('error', reject);

    archive.pipe(output);

    // Add directory with base name
    archive.directory(sourceDir, baseName);

    archive.finalize();
  });
}

/**
 * Validate that zip was created and has content
 */
export async function validateZip(zipPath) {
  try {
    const stats = await stat(zipPath);
    return stats.size > 1024; // At least 1KB
  } catch (error) {
    return false;
  }
}
