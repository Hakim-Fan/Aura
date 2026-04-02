;
import { applyConfigEnvironmentVariables } from './utils/managedEnv.js';
import type { PermissionMode } from './utils/permissions/PermissionMode.js';
import { getBaseRenderOptions } from './utils/renderOptions.js';
import { getSettingsWithAllErrors } from './utils/settings/allErrors.js';
import { hasAutoModeOptIn, hasSkipDangerousModePermissionPrompt } from './utils/settings/settings.js';
import { handleMcpjsonServerApprovals } from './services/mcpServerApproval.js';
import { getSystemContext } from './context/js';
import { checkHasTrustDialogAccepted } from './utils/config.js';
import { initializeTelemetryAfterTrust } from './entrypoints/init.js';
import { showDialog, showSetupDialog } from './interactiveHelpers.tsx';
import { Root, RenderOptions, TextProps } from './ink.js';
import { gracefulShutdown } from './utils/gracefulShutdown.js';
import { startDeferredPrefetches } from './main.js';
import { Command } from './commands.js';
import { FpsMetrics, FpsTracker } from './utils/fpsTracker.js';
import { StatsStore, createStatsStore, setStatsStore } from './context/stats.js';
import { isSynchronizedOutputSupported } from './ink/terminal.js';
import { appendFileSync } from 'fs';

export async function renderAndRun(root: Root, element: React.ReactNode): Promise<void> {
  root.render(element);
  startDeferredPrefetches();
  await root.waitUntilExit();
  await gracefulShutdown(0);
}

export async function showSetupScreens(root: Root, _permissionMode: PermissionMode, _allowDangerouslySkipPermissions: boolean, commands?: Command[]): Promise<boolean> {
  if (!checkHasTrustDialogAccepted()) {
    const {
      TrustDialog
    } = await import('./components/TrustDialog/TrustDialog.js');
    await showSetupDialog(root, done => <TrustDialog commands={commands} onDone={done} />);
  }

  // Now that trust is established, prefetch system context if it wasn't already
  void getSystemContext();

  const {
    errors: allErrors
  } = getSettingsWithAllErrors();
  if (allErrors.length === 0) {
    await handleMcpjsonServerApprovals(root);
  }

  applyConfigEnvironmentVariables();
  setImmediate(() => initializeTelemetryAfterTrust());

  return false;
}

export function getRenderContext(exitOnCtrlC: boolean): {
  renderOptions: RenderOptions;
  getFpsMetrics: () => FpsMetrics | undefined;
  stats: StatsStore;
} {
  let lastFlickerTime = 0;
  const baseOptions = getBaseRenderOptions(exitOnCtrlC);

  const fpsTracker = new FpsTracker();
  const stats = createStatsStore();
  setStatsStore(stats);

  const frameTimingLogPath = process.env.CLAUDE_CODE_FRAME_TIMING_LOG;
  return {
    getFpsMetrics: () => fpsTracker.getMetrics(),
    stats,
    renderOptions: {
      ...baseOptions,
      onFrame: event => {
        fpsTracker.record(event.durationMs);
        stats.observe('frame_duration_ms', event.durationMs);
        if (frameTimingLogPath && event.phases) {
          const line =
          JSON.stringify({
            total: event.durationMs,
            ...event.phases,
            rss: process.memoryUsage.rss(),
            cpu: process.cpuUsage()
          }) + '\n';
          appendFileSync(frameTimingLogPath, line);
        }
        if (isSynchronizedOutputSupported()) {
          return;
        }
        for (const flicker of event.flickers) {
          if (flicker.reason === 'resize') {
            continue;
          }
          const now = Date.now();
          if (now - lastFlickerTime < 1000) {
            lastFlickerTime = now;
          }
        }
      }
    }
  };
}