# ES CLI (Element Stark CLI)

A CLI tool for building and deploying WooCommerce extensions. Replaces the need for grunt in individual plugins with a single global tool that handles:

- CSS minification
- POT file generation (i18n)
- Distribution zip creation
- Version management
- PHPCS security checks
- QIT testing
- Git tagging
- WooCommerce.com deployment
- Background deployment monitoring

## Installation

```bash
cd ~/Packages/wc-deploy
npm install
npm link
```

Now `es` command is available globally (also aliased as `wc-deploy`).

## Quick Start

```bash
# Navigate to your plugin directory
cd /path/to/your/woocommerce-extension

# Initialize configuration
es init

# Build distribution package
es build

# Run security checks
es phpcs

# Full deployment
es deploy
```

## Commands

| Command | Description |
|---------|-------------|
| `es init` | Initialize `.deployrc.json` configuration |
| `es build` | Build distribution package (CSS minify, POT, zip) |
| `es pot` | Generate POT file for translations |
| `es phpcs` | Run PHP CodeSniffer security check |
| `es qit [type]` | Run QIT tests (builds first, then runs tests) |
| `es qit version` | Check deployed version on WooCommerce.com |
| `es sync` | Quick compatibility update (bump WP/WC versions) |
| `es version [ver]` | Update version numbers interactively |
| `es deploy` | Full deployment workflow with background monitoring |
| `es status` | Check WooCommerce.com deployment status |

## Setup

### 1. Configure WooCommerce.com Credentials

Create `~/.wccom-deploy`:

```bash
WCCOM_USER=your_woocommerce_username
WCCOM_PASSWORD=your_application_password
WCCOM_API_URL=https://woocommerce.com/wp-json/wc/submission/runner/v1
```

**To get an application password:**
1. Go to https://woocommerce.com/my-account/
2. Navigate to your account settings
3. Create an application password for API access

### 2. Configure Each Extension

Run `es init` in your plugin directory, or create `.deployrc.json` manually:

```json
{
  "productId": "171144",
  "slug": "woocommerce-wishlists",
  "mainFile": "woocommerce-wishlists.php",
  "versionFiles": [
    {
      "file": "woocommerce-wishlists.php",
      "pattern": " * Version: {{version}}"
    },
    {
      "file": "package.json",
      "pattern": "\"version\": \"{{version}}\""
    }
  ],
  "minifyCss": true,
  "generatePot": true,
  "distPath": "./dist"
}
```

### 3. Install PHPCS (Recommended)

Install WooCommerce sniffs globally:

```bash
composer global require woocommerce/woocommerce-sniffs
```

A security-focused ruleset is at `~/.composer/phpcs-security.xml`.

## Command Details

### `es build`

Build the distribution package:
1. Cleans dist directory
2. CSS minification (creates `.min.css` files)
3. POT file generation
4. Distribution zip creation

```bash
es build
es build --dry-run              # Preview without changes
es build --skip-version-check   # Skip version check
es build --force                # Continue despite version mismatch
```

### `es phpcs`

Run PHP CodeSniffer with security-focused rules:

```bash
es phpcs                    # Security checks only (escaping, sanitization, SQL)
es phpcs --full             # Full WooCommerce-Core standards
es phpcs --fix              # Auto-fix with PHPCBF
es phpcs --errors-only      # Show only errors, not warnings
es phpcs --path src/        # Scan specific path
```

### `es qit [testType]`

Run QIT (Quality Insights Toolkit) tests. **Automatically builds first** to ensure you're testing the latest code.

```bash
es qit                      # Default: security test
es qit security             # Security test
es qit activation           # Activation test
es qit all                  # Security + activation
es qit version              # Check deployed version on WooCommerce.com
es qit --skip-build         # Skip build, use existing zip
es qit --verbose            # Show full test output
```

### `es sync`

Quick compatibility update for WP/WC version bumps:

1. Checks repo is clean
2. Runs PHPCS check
3. Fetches latest WP/WC versions
4. Updates "Tested up to" headers
5. Bumps patch version
6. Builds and deploys
7. Commits, tags, pushes

```bash
es sync                     # Full sync
es sync --dry-run           # Preview changes
es sync --skip-phpcs        # Skip PHPCS check
```

### `es deploy`

Full deployment workflow with background monitoring:

1. Checks WP/WC compatibility (offers to update)
2. Runs PHPCS security check
3. Prompts for version and changelog
4. Updates version files and changelog
5. Builds distribution package
6. **Commits locally (no tag yet)**
7. Uploads to WooCommerce.com
8. **Spawns background monitor**

The background monitor:
- Polls deployment status every 30 seconds (up to 30 min)
- On success: macOS notification "ready to tag"
- On warning: the same notification, plus the failed spec names of each warning
  test run (`wc-deploy monitor` lists them; `escope qit-runs <slug>` shows
  whether they persist across releases)
- On failure: notification with error

Tag and push by hand once the run settles, so git tags only exist for
deployed versions.

```bash
es deploy
es deploy --version 2.4.0   # Specify version directly
es deploy --dry-run         # Preview without changes
es deploy --skip-build      # Skip build step
es deploy --skip-phpcs      # Skip PHPCS check
es deploy --skip-deploy     # Skip WooCommerce.com upload
```

**If deployment fails:**
```bash
# Fix the issue, then:
git commit --amend          # Update your commit
es build                    # Rebuild
es deploy --skip-build      # Retry deployment
```

### `es version [newVersion]`

Update version numbers interactively or directly:

```bash
es version                  # Interactive prompt
es version 2.4.0            # Direct version
es version 2.4.0 --dry-run  # Preview changes
es version -m "Fixed bug"   # Add changelog entry
```

## Configuration Options

### `.deployrc.json`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `productId` | string | required | WooCommerce.com product ID |
| `slug` | string | required | Plugin slug (used for zip naming) |
| `mainFile` | string | required | Main plugin PHP file |
| `versionFiles` | array | `[]` | Files where version should be updated |
| `minifyCss` | boolean | `true` | Enable CSS minification |
| `cssPath` | string | `"assets/css"` | Path to CSS files |
| `generatePot` | boolean | `true` | Enable POT file generation |
| `exclude` | array | `[]` | Additional files/folders to exclude from zip |
| `distPath` | string | `"./dist"` | Output directory for distribution files |
| `preBuildCommand` | string | `null` | Custom command to run before build |

### Default Exclusions

The following are always excluded from the distribution zip:
- `node_modules`, `.git`, `.github`, `.vscode`, `.idea`
- `dist`, `tests`, `grunt`
- `composer.json`, `composer.lock`, `package-lock.json`
- `Gruntfile.js`, `.deployrc.json`, `.env`
- `.phpcs.xml`, `phpcs.xml`, `.eslintrc`
- `README.md`, `.DS_Store`

## Requirements

- Node.js 18+
- [WP-CLI](https://wp-cli.org/) (for POT file generation)
- PHPCS with WooCommerce sniffs (for `es phpcs`)
- QIT CLI (for `es qit`)

## License

MIT
