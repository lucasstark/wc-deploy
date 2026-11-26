import { access, readFile, writeFile, mkdir } from 'fs/promises';
import { join, basename } from 'path';
import { listShippedFiles } from './zip-builder.js';
import wpPot from 'wp-pot';
import { logger } from '../utils/logger.js';

/**
 * Extract text domain from main plugin file
 */
async function getTextDomain(mainFile) {
  try {
    const pluginPath = join(process.cwd(), mainFile);
    const content = await readFile(pluginPath, 'utf-8');

    // Match: * Text Domain: wc_wishlist
    const match = content.match(/\*\s*Text Domain:\s*([^\s\n]+)/i);
    return match ? match[1].trim() : null;
  } catch (error) {
    return null;
  }
}

/**
 * Extract domain path from main plugin file
 */
async function getDomainPath(mainFile) {
  try {
    const pluginPath = join(process.cwd(), mainFile);
    const content = await readFile(pluginPath, 'utf-8');

    // Match: * Domain Path: /i18n/languages/
    const match = content.match(/\*\s*Domain Path:\s*([^\s\n]+)/i);
    return match ? match[1].trim() : '/languages/';
  } catch (error) {
    return '/languages/';
  }
}

/**
 * Extract plugin metadata from main plugin file
 */
async function getPluginInfo(mainFile) {
  try {
    const pluginPath = join(process.cwd(), mainFile);
    const content = await readFile(pluginPath, 'utf-8');

    const getName = () => {
      const match = content.match(/\*\s*Plugin Name:\s*([^\n]+)/i);
      return match ? match[1].trim() : null;
    };

    const getAuthor = () => {
      const match = content.match(/\*\s*Author:\s*([^\n]+)/i);
      return match ? match[1].trim() : null;
    };

    const getVersion = () => {
      const match = content.match(/\*\s*Version:\s*([^\s\n]+)/i);
      return match ? match[1].trim() : null;
    };

    return {
      name: getName(),
      author: getAuthor(),
      version: getVersion()
    };
  } catch (error) {
    return { name: null, author: null, version: null };
  }
}

/**
 * Collect translatable strings from the JavaScript files that ship in the zip.
 * WordPress loads a script's JSON translations by the md5 of the script's path,
 * and `wp i18n make-json` names each JSON file by the md5 of the `#:` reference,
 * so each reference names the built file, never its source under src/.
 * wp-pot's JS parser stops on modern syntax, so this reads the literal
 * arguments of __() calls that use the plugin's text domain (minified calls
 * read `(0,t.__)("…","domain")`), plus the title, description and keywords of
 * each block.json.
 */
async function collectJsStrings(textDomain, excludeList) {
  const files = (await listShippedFiles(process.cwd(), excludeList))
    .filter((file) => (/\.(js|jsx)$/.test(file) && !/\.min\.js$/.test(file)) || basename(file) === 'block.json')
    .sort();

  const quoted = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
  const call = new RegExp(String.raw`\b__\)?\(\s*${quoted}\s*,\s*${quoted}\s*[,)]`, 'g');
  const unquote = (text) => text.slice(1, -1).replace(/\\(['"\\])/g, '$1');
  const strings = [];

  for (const ref of files) {
    const content = await readFile(join(process.cwd(), ref), 'utf-8');

    if (basename(ref) === 'block.json') {
      let block;
      try {
        block = JSON.parse(content);
      } catch (error) {
        continue;
      }
      if (block.textdomain !== textDomain) {
        continue;
      }
      for (const text of [block.title, block.description, ...(block.keywords || [])]) {
        if (text) {
          strings.push({ id: text, ref });
        }
      }
      continue;
    }

    for (const match of content.matchAll(call)) {
      if (unquote(match[2]) === textDomain) {
        const line = content.slice(0, match.index).split('\n').length;
        strings.push({ id: unquote(match[1]), ref: `${ref}:${line}` });
      }
    }
  }
  return strings;
}

/**
 * Add the JavaScript references to the .pot. A string the PHP pass already
 * listed gains the references, so make-json puts it in each script's JSON.
 */
async function appendJsStrings(potFile, textDomain, excludeList) {
  const strings = await collectJsStrings(textDomain, excludeList);
  if (!strings.length) {
    return;
  }

  const refsById = new Map();
  for (const { id, ref } of strings) {
    if (!refsById.has(id)) {
      refsById.set(id, new Set());
    }
    refsById.get(id).add(ref);
  }

  let pot = (await readFile(potFile, 'utf-8')).replace(/\s*$/, '\n');
  const escape = (text) => text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  let added = '';

  for (const [id, refs] of refsById) {
    const entry = `msgid "${escape(id)}"`;
    const refLines = [...refs].map((ref) => `#: ${ref}\n`).join('');
    const at = pot.indexOf(`\n${entry}\n`);
    const start = at === -1 ? -1 : pot.lastIndexOf('\n\n', at) + 2;

    // A msgctxt entry is a different string; only a context-free entry gains the references.
    if (at !== -1 && !pot.slice(start, at).includes('msgctxt')) {
      pot = pot.slice(0, start) + refLines + pot.slice(start);
    } else {
      added += `\n${refLines}${entry}\nmsgstr ""\n`;
    }
  }

  await writeFile(potFile, pot + added);
}

/**
 * Generate POT file using wp-pot (pure Node.js, no WP-CLI needed)
 */
export async function generatePotFile(config, dryRun = false) {
  const textDomain = await getTextDomain(config.mainFile);
  const domainPath = await getDomainPath(config.mainFile);
  const pluginInfo = await getPluginInfo(config.mainFile);

  if (!textDomain) {
    logger.warn('Text Domain not found in plugin file, skipping POT generation');
    return false;
  }

  const potDir = join(process.cwd(), domainPath.replace(/^\//, ''));
  const potFile = join(potDir, `${textDomain}.pot`);

  if (dryRun) {
    logger.info(`Would generate POT file: ${textDomain}.pot`);
    logger.info(`Output path: ${potFile}`);
    return true;
  }

  const spinner = logger.spinner('Generating POT file...');

  try {
    // Ensure the output directory exists
    await mkdir(potDir, { recursive: true });

    // Generate POT file using wp-pot
    wpPot({
      destFile: potFile,
      domain: textDomain,
      package: pluginInfo.name || config.slug,
      src: [
        join(process.cwd(), '**/*.php'),
        '!' + join(process.cwd(), 'node_modules/**'),
        '!' + join(process.cwd(), 'vendor/**'),
        '!' + join(process.cwd(), 'dist/**'),
        '!' + join(process.cwd(), 'tests/**')
      ],
      bugReport: config.bugReportUrl || '',
      lastTranslator: pluginInfo.author || '',
      team: pluginInfo.author || ''
    });

    await appendJsStrings(potFile, textDomain, config.exclude || []);

    spinner.succeed(`POT file generated: ${textDomain}.pot`);
    return true;
  } catch (error) {
    spinner.fail('POT file generation failed');
    logger.error(error.message);
    return false;
  }
}

/**
 * Check if POT file exists
 */
export async function checkPotFile(config) {
  const textDomain = await getTextDomain(config.mainFile);
  const domainPath = await getDomainPath(config.mainFile);

  if (!textDomain) {
    return { exists: false, path: null };
  }

  const potDir = join(process.cwd(), domainPath.replace(/^\//, ''));
  const potFile = join(potDir, `${textDomain}.pot`);

  try {
    await access(potFile);
    return { exists: true, path: potFile, textDomain };
  } catch (error) {
    return { exists: false, path: potFile, textDomain };
  }
}
