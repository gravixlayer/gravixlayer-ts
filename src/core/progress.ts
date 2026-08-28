/**
 * TTY progress for long-running builds.
 *
 * Phase labels, spinner, and elapsed-time formatting live in the SDK.
 * Customer scripts only call `buildAndWait` / `deploy`; they do not implement
 * this UI. Template and agent builds share the same two stages and timers.
 */

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const SPINNER_INTERVAL_MS = 100;

/** API phase → stable stage name. Two user-visible stages, then READY. */
export const TEMPLATE_BUILD_PHASE_LABELS: Readonly<Record<string, string>> = {
  building: 'BUILDING',
  uploading: 'VERIFYING',
  completed: 'READY',
  initializing: 'BUILDING',
  preparing: 'BUILDING',
  finalizing: 'BUILDING',
  distributing: 'VERIFYING',
};

/** Same stage names as template builds so deploy and template waits match. */
export const AGENT_BUILD_PHASE_LABELS: Readonly<Record<string, string>> = {
  ...TEMPLATE_BUILD_PHASE_LABELS,
};

interface Writable {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

function stderr(): Writable | undefined {
  const proc = (globalThis as { process?: { stderr?: Writable } }).process;
  return proc?.stderr;
}

/** Monotonic milliseconds. `performance.now` is available in Node and browsers. */
export function monotonicMs(): number {
  return performance.now();
}

/** Format elapsed seconds the same way as the Python SDK (`12.3s`, `1m 22s`). */
export function formatDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) {
    return '0.0s';
  }
  if (secs < 60) {
    return `${secs.toFixed(1)}s`;
  }
  const minutes = Math.floor(secs / 60);
  const rem = secs - minutes * 60;
  return `${minutes}m ${rem.toFixed(0)}s`;
}

/** Map an API phase string to the user-facing stage label. */
export function displayPhaseLabel(
  phase: string,
  labels: Readonly<Record<string, string>> = TEMPLATE_BUILD_PHASE_LABELS,
): string {
  return labels[phase] ?? phase.toUpperCase();
}

/** User-visible stages only move forward. READY is printed by `succeed`, not as a spinner. */
const STAGE_RANK: Readonly<Record<string, number>> = {
  BUILDING: 0,
  VERIFYING: 1,
  READY: 2,
};

/**
 * Next spinner label, or `undefined` when the stage must not change.
 *
 * After VERIFYING, a later `building` (or any earlier/unknown phase) is ignored
 * so a control-plane flicker cannot print a second BUILDING line. `completed`
 * maps to READY and is reserved for the terminal success line.
 */
export function nextDisplayStage(
  current: string,
  rawPhase: string,
  labels: Readonly<Record<string, string>> = TEMPLATE_BUILD_PHASE_LABELS,
): string | undefined {
  const label = displayPhaseLabel(rawPhase, labels);
  if (!label || label === current || label === 'READY') {
    return undefined;
  }
  const nextRank = STAGE_RANK[label];
  const prevRank = STAGE_RANK[current] ?? -1;
  if (nextRank === undefined) {
    return prevRank >= 0 ? undefined : label;
  }
  if (nextRank < prevRank) {
    return undefined;
  }
  return label;
}

/** True when the process can show an in-place spinner (interactive TTY). */
export function stderrIsTty(): boolean {
  return stderr()?.isTTY === true;
}

/** Write to stderr when it exists. No-op in browsers and tests without a stream. */
export function writeStderr(text: string): void {
  stderr()?.write(text);
}

type IntervalHandle = ReturnType<typeof setInterval> & { unref?: () => void };

/**
 * In-place spinner on stderr. One line per stage, then a DONE line with the
 * stage timer. Does not print percents.
 */
export class PhaseSpinner {
  private label = '';
  private phaseStartMs = 0;
  private frame = 0;
  private timer: IntervalHandle | undefined;
  private readonly write: (text: string) => void;

  constructor(write: (text: string) => void = writeStderr) {
    this.write = write;
  }

  update(label: string, phaseStartMs: number, elapsedSecs: number, prevLabel: string): void {
    if (prevLabel) {
      this.stop();
      this.write(`\r  ${prevLabel}... DONE (${formatDuration(elapsedSecs)})\n`);
    }
    this.label = label;
    this.phaseStartMs = phaseStartMs;
    this.frame = 0;
    this.timer = setInterval(() => this.tick(), SPINNER_INTERVAL_MS);
    this.timer.unref?.();
    this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  finish(label: string, elapsedSecs: number, totalSecs: number, readyMessage: string): void {
    this.stop();
    if (label) {
      this.write(`\r  ${label}... DONE (${formatDuration(elapsedSecs)})\n`);
    }
    this.write(`  READY: ${readyMessage} (${formatDuration(totalSecs)})\n`);
  }

  fail(message: string, totalSecs: number): void {
    this.stop();
    this.write(`\r  FAILED: ${message} (${formatDuration(totalSecs)})\n`);
  }

  private tick(): void {
    const elapsed = formatDuration((monotonicMs() - this.phaseStartMs) / 1000);
    const char = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
    this.frame += 1;
    this.write(`\r  ${this.label}... ${char} ${elapsed}`);
  }
}

/**
 * Owns spinner lifecycle for a single `buildAndWait` / `waitForBuild` call.
 *
 * Enabled only on a TTY when the caller did not supply their own phase hook.
 */
export class BuildProgress {
  private readonly spinner: PhaseSpinner | null;
  private lastDisplay = '';
  private phaseStartMs: number;
  private readonly buildStartMs: number;

  constructor(enabled: boolean, heading?: string) {
    this.buildStartMs = monotonicMs();
    this.phaseStartMs = this.buildStartMs;
    this.spinner = enabled ? new PhaseSpinner() : null;
    if (enabled && heading) {
      writeStderr(`\n${heading}\n\n`);
    }
  }

  /** Advance the spinner when the *display* stage moves forward. */
  noteStage(rawPhase: string, labels: Readonly<Record<string, string>>): void {
    const label = nextDisplayStage(this.lastDisplay, rawPhase, labels);
    if (label === undefined) {
      return;
    }
    const now = monotonicMs();
    const elapsedSecs = (now - this.phaseStartMs) / 1000;
    this.spinner?.update(label, now, elapsedSecs, this.lastDisplay);
    this.phaseStartMs = now;
    this.lastDisplay = label;
  }

  succeed(readyMessage: string, trailer?: string): void {
    const now = monotonicMs();
    if (this.spinner) {
      this.spinner.finish(
        this.lastDisplay,
        (now - this.phaseStartMs) / 1000,
        (now - this.buildStartMs) / 1000,
        readyMessage,
      );
      if (trailer) {
        writeStderr(trailer);
      }
    }
  }

  fail(message: string): void {
    const now = monotonicMs();
    if (this.spinner) {
      this.spinner.fail(message, (now - this.buildStartMs) / 1000);
    } else {
      this.stop();
    }
  }

  stop(): void {
    this.spinner?.stop();
  }
}
