import chalk from 'chalk';
import { execa } from 'execa';
import { getCredentials } from '../utils/env-loader.js';
import { logger } from '../utils/logger.js';
import {
  listRuns,
  updateRuns,
  removeRuns,
  isTerminalStatus,
  PATHS
} from '../state/runs-store.js';

const POLL_INTERVAL_MS = 30_000;

const PENDING_STATUSES = new Set(['pending', 'running', 'queued', 'in_progress']);

export async function monitorCommand(options) {
  if (options.purgeAll) {
    const removed = await removeRuns(() => true);
    logger.success(`Removed ${removed} run(s) from ${PATHS.STORE_FILE}`);
    return;
  }

  if (options.purge) {
    const removed = await removeRuns(r => isTerminalStatus(r.status));
    logger.success(`Removed ${removed} terminal run(s) from ${PATHS.STORE_FILE}`);
    return;
  }

  if (options.watch) {
    return watchLoop(options);
  }

  if (options.refresh) {
    await refreshAll();
  }

  const runs = await listRuns();
  if (options.json) {
    console.log(JSON.stringify({ runs }, null, 2));
  } else {
    console.log(chalk.bold.cyan('\n  Tracked deployment runs\n'));
    printTable(runs);
    if (!options.refresh) {
      console.log(chalk.gray('  (state-only; pass --refresh to poll the cloud, --watch to follow)\n'));
    }
  }
}

async function refreshAll() {
  const runs = await listRuns({ terminal: false });
  const deployRuns = runs.filter(r => r.kind === 'deploy' && r.productId);

  if (deployRuns.length === 0) return;

  let credentials;
  try {
    credentials = getCredentials();
  } catch (error) {
    logger.warn(`Cannot poll deploy status: ${error.message}`);
    return;
  }

  await Promise.all(deployRuns.map(async (run) => {
    try {
      const status = await fetchDeployStatus(run.productId, credentials);

      // Deploy is no longer in progress: it finished. Settle the run to a
      // terminal state using the test results we already collected.
      if (status.__deployFinished) {
        const known = run.testRuns ? Object.values(run.testRuns) : [];
        const failed = known.some(t => t.status === 'failed' || t.status === 'error');
        const warned = known.some(t => t.status === 'warning');
        await updateRuns(
          r => r.kind === 'deploy' && r.productId === run.productId,
          { status: failed ? 'failed' : warned ? 'warning' : 'success', error: null }
        );
        return;
      }

      const aggregate = computeAggregateStatus(status);
      await updateRuns(
        r => r.kind === 'deploy' && r.productId === run.productId,
        {
          status: aggregate,
          testRuns: await withFailedSpecs(status.test_runs, run.testRuns),
          apiVersion: status.version || null,
          error: null
        }
      );
    } catch (error) {
      await updateRuns(
        r => r.kind === 'deploy' && r.productId === run.productId,
        { error: error.message }
      );
    }
  }));
}

// A "warning" is a test run with failed specs. Record their names once, so
// the warning reads as "these two specs failed", not as a colour. Wishlists
// shipped six releases with the same two Woo E2E failures - its own - because
// a warning read as "non-blocking noise".
async function withFailedSpecs(testRuns, previous) {
  if (!testRuns) return null;
  const out = {};
  for (const [id, t] of Object.entries(testRuns)) {
    const prior = previous?.[id]?.failedSpecs;
    out[id] = { ...t };
    if (prior) out[id].failedSpecs = prior;
    else if (t.status === 'warning' || t.status === 'failed') {
      const specs = await fetchFailedSpecs(id);
      if (specs) out[id].failedSpecs = specs;
    }
  }
  return out;
}

async function fetchFailedSpecs(testRunId) {
  try {
    const { stdout } = await execa('qit', ['get', String(testRunId), '--json'], { timeout: 60_000, reject: false });
    const data = JSON.parse(stdout.slice(stdout.indexOf('{')));
    const tests = data?.ctrf_json?.results?.tests || [];
    return tests.filter(t => t.status === 'failed').map(t => t.name);
  } catch {
    return null;
  }
}

async function fetchDeployStatus(productId, credentials) {
  const FormData = (await import('form-data')).default;
  const fetch = (await import('node-fetch')).default;

  const form = new FormData();
  form.append('product_id', productId);
  form.append('username', credentials.username);
  form.append('password', credentials.password);

  const response = await fetch(`${credentials.apiUrl}/product/deploy/status`, {
    method: 'POST',
    body: form,
    headers: form.getHeaders()
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    // The API returns 400 "no deploy in progress" once a deploy has finished.
    // That is the completion signal, not an error — surface it as such.
    if (response.status === 400 && body.includes('submission_runner_no_deploy_in_progress')) {
      return { __deployFinished: true };
    }
    throw new Error(`API ${response.status}: ${body.slice(0, 160)}`);
  }

  return response.json();
}

function computeAggregateStatus(apiStatus) {
  if (!apiStatus || typeof apiStatus !== 'object') return 'error';

  if (apiStatus.status === 'failed' || apiStatus.status === 'error') return 'failed';

  const testRuns = apiStatus.test_runs ? Object.values(apiStatus.test_runs) : [];

  if (testRuns.some(t => t.status === 'failed' || t.status === 'error')) {
    return 'failed';
  }

  const anyPending = testRuns.some(t => PENDING_STATUSES.has(t.status));
  if (anyPending) return apiStatus.status || 'running';

  // Warnings are non-blocking on the marketplace (Validation and Woo E2E warn on
  // most releases). Only pending or failed states withhold a terminal success.
  // They are still reported as 'warning', not folded into 'success': a warning
  // is failed specs, and only its spec names say whose they are.
  if (testRuns.length > 0 && testRuns.every(t => t.status === 'success' || t.status === 'warning')) {
    return testRuns.some(t => t.status === 'warning') ? 'warning' : 'success';
  }

  // No test_runs yet (just queued) or unrecognized state — preserve API value.
  return apiStatus.status || 'queued';
}

async function watchLoop(options) {
  console.log(chalk.bold.cyan('\n  Watching deployment runs (Ctrl-C to stop)\n'));

  const notifiedKeys = new Set();
  // Pre-load already-terminal runs so we don't fire stale notifications.
  const initial = await listRuns();
  for (const run of initial) {
    if (isTerminalStatus(run.status)) notifiedKeys.add(runKey(run));
  }

  while (true) {
    const inFlightBefore = (await listRuns({ terminal: false })).length;
    if (inFlightBefore === 0 && initial.length > 0) {
      // Nothing to watch on entry.
      logger.info('No in-flight runs.');
      return;
    }

    await refreshAll();
    const runs = await listRuns();

    for (const run of runs) {
      const key = runKey(run);
      if (isTerminalStatus(run.status) && !notifiedKeys.has(key)) {
        notifiedKeys.add(key);
        await notifyTerminal(run);
      }
    }

    console.clear();
    console.log(chalk.bold.cyan('  Watching deployment runs (Ctrl-C to stop)\n'));
    printTable(runs);
    console.log(chalk.gray(`  Last poll: ${new Date().toLocaleTimeString()}    Polling every ${POLL_INTERVAL_MS / 1000}s`));

    const inFlight = runs.filter(r => !isTerminalStatus(r.status));
    if (inFlight.length === 0) {
      console.log(chalk.green('\n  All runs complete.\n'));
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function notifyTerminal(run) {
  const isSuccess = run.status === 'success';
  const securityFailed = run.kind === 'deploy'
    && run.testRuns
    && Object.values(run.testRuns).some(t => t.test_type === 'security' && t.status !== 'success');

  let title, message, sound;
  if (securityFailed) {
    title = '🛑 Security issue';
    message = `${run.slug} v${run.version} — security test failed`;
    sound = 'Basso';
  } else if (run.status === 'warning') {
    const warned = Object.values(run.testRuns || {}).filter(t => t.status === 'warning');
    const specs = warned.reduce((n, t) => n + (t.failedSpecs?.length || 0), 0);
    title = '⚠️ Deploy warning';
    message = `${run.slug} v${run.version} — ready to tag; ${specs || 'some'} failed specs in ${warned.map(t => t.test_type).join(', ')}. Check: escope qit-runs ${run.slug}`;
    sound = 'Purr';
  } else if (isSuccess) {
    title = '✅ Deploy success';
    message = `${run.slug} v${run.version} — ready to tag`;
    sound = 'Glass';
  } else {
    title = '❌ Deploy failed';
    message = `${run.slug} v${run.version} — ${run.status}`;
    sound = 'Basso';
  }

  await macOsNotify(title, message, sound);
}

async function macOsNotify(title, message, sound = 'Glass') {
  const escTitle = title.replace(/"/g, '\\"');
  const escMsg = message.replace(/"/g, '\\"');
  const script = `display notification "${escMsg}" with title "${escTitle}" sound name "${sound}"`;
  try {
    await execa('osascript', ['-e', script], { timeout: 5000 });
  } catch {
    // Notifications are best-effort.
  }
}

function printTable(runs) {
  if (runs.length === 0) {
    console.log(chalk.gray(`  (no tracked runs — state file: ${PATHS.STORE_FILE})\n`));
    return;
  }

  const header = `  ${'KIND'.padEnd(7)} ${'SLUG'.padEnd(40)} ${'VERSION'.padEnd(9)} ${'STATUS'.padEnd(12)} AGE`;
  console.log(chalk.bold(header));

  for (const r of runs) {
    const age = formatAge(r.startedAt);
    const status = colorStatus(r.status)((r.status || '?').padEnd(12));
    const kind = r.kind.padEnd(7);
    const slug = (r.slug || '').slice(0, 40).padEnd(40);
    const version = (r.version || '').padEnd(9);
    console.log(`  ${kind} ${slug} ${version} ${status} ${age}`);

    if (r.kind === 'deploy' && r.testRuns) {
      for (const t of Object.values(r.testRuns)) {
        const tStatus = colorStatus(t.status)((t.status || '?').padEnd(10));
        const url = t.result_url ? chalk.gray(` ${t.result_url}`) : '';
        console.log(`    ${chalk.gray('•')} ${(t.test_type || '?').padEnd(20)} ${tStatus}${url}`);
        for (const spec of t.failedSpecs || []) {
          console.log(`        ${chalk.magenta('✗')} ${spec}`);
        }
      }
      if (r.status === 'warning') {
        console.log(chalk.magenta(`    whose failures? escope qit-runs ${r.slug} --against <another extension>`));
      }
    }

    if (r.kind === 'qit' && r.qitResultUrl) {
      console.log(`    ${chalk.gray('•')} ${chalk.gray(r.qitResultUrl)}`);
    }

    if (r.error) {
      console.log(`    ${chalk.red('error:')} ${chalk.red(r.error)}`);
    }
  }
  console.log();
}

function colorStatus(status) {
  if (status === 'success') return chalk.green;
  if (status === 'warning') return chalk.magenta;
  if (status === 'failed' || status === 'error') return chalk.red;
  if (PENDING_STATUSES.has(status)) return chalk.yellow;
  return chalk.gray;
}

function formatAge(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}

function runKey(run) {
  if (run.kind === 'deploy') return `deploy:${run.productId}:${run.version}`;
  if (run.kind === 'qit') return `qit:${run.qitRunId || `${run.slug}:${run.testType}:${run.startedAt}`}`;
  return `${run.kind}:${run.slug}:${run.startedAt}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
