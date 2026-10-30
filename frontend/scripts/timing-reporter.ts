import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

/** Opt in with --reporter=list,./scripts/timing-reporter.ts. */
export default class TimingReporter implements Reporter {
  private output = "";
  private workers = 0;
  private selected: unknown[] = [];
  private tests: Array<Record<string, unknown>> = [];
  private observedStarts = new WeakMap<TestResult, string>();

  onBegin(config: FullConfig, suite: Suite) {
    this.output = process.env.FORKWISE_TIMING_OUTPUT
      ?? join(config.projects[0]!.outputDir, "timing.json");
    this.workers = config.workers;
    this.selected = suite.allTests().map((test) => ({
      titlePath: test.titlePath(),
      project: test.parent.project()?.name ?? null,
      parameters: null,
      repeatEachIndex: test.repeatEachIndex,
      expectedStatus: test.expectedStatus,
      annotations: test.annotations,
    }));
  }

  onTestBegin(_test: TestCase, result: TestResult) {
    this.observedStarts.set(result, new Date().toISOString());
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const observedEndAt = new Date().toISOString();
    // Only roots count: Before/After Hooks already contain their nested fixtures.
    const preparation = result.steps.find((step) => step.category === "hook" && step.title === "Before Hooks");
    const teardown = result.steps.find((step) => step.category === "hook" && step.title === "After Hooks");
    const roots = result.steps.filter((step) => step.category === "hook" || step.category === "fixture");
    const hookFixtureDurationMs = roots.reduce((sum, step) => sum + step.duration, 0);
    // beforeAll/worker teardown can use separate timeout slots. Their walltime can
    // exceed result.duration; that does not establish a negative body duration.
    const residual = preparation && teardown && hookFixtureDurationMs <= result.duration
      ? result.duration - hookFixtureDurationMs : null;
    this.tests.push({
      titlePath: test.titlePath(), file: test.location.file,
      project: test.parent.project()?.name ?? null,
      parameters: null, // The public TestCase API has no generic parameter field.
      repeatEachIndex: test.repeatEachIndex, retry: result.retry,
      expectedStatus: test.expectedStatus, annotations: result.annotations,
      status: result.status, outcome: test.outcome(),
      timeoutMs: test.timeout, retries: test.retries,
      workerIndex: result.workerIndex, parallelIndex: result.parallelIndex,
      startedAt: result.startTime.toISOString(),
      finishedAt: new Date(result.startTime.getTime() + result.duration).toISOString(),
      observedBeginAt: this.observedStarts.get(result) ?? null,
      observedEndAt,
      durationMs: result.duration,
      preparationMs: preparation?.duration ?? null,
      teardownMs: teardown?.duration ?? null,
      hookFixtureDurationMs: roots.length ? hookFixtureDurationMs : null,
      unattributedResidualMs: residual,
      hookFixtureRoots: roots.map((step) => ({ title: step.title, category: step.category, durationMs: step.duration })),
    });
  }

  onEnd(result: FullResult) {
    mkdirSync(dirname(this.output), { recursive: true });
    writeFileSync(this.output, JSON.stringify({
      schemaVersion: 1, status: result.status, workers: this.workers,
      startedAt: result.startTime.toISOString(), suiteWallTimeMs: result.duration,
      summedTestDurationMs: this.tests.reduce((sum, test) => sum + (test.durationMs as number), 0),
      build: null, serverLifecycle: null,
      notes: [
        "Parallel test durations are not suite walltime.",
        "Root hooks include nested fixtures; residuals are unattributed, not pure test body time.",
        "Separate hook timeout slots may exceed test duration; such residuals remain null.",
        "Build and server lifecycle require external records; result end timestamps use reported test duration.",
        "Observed callback times include reporter delivery latency; they are not server lifecycle timestamps.",
      ],
      selected: this.selected, tests: this.tests,
    }, null, 2) + "\n");
  }
}
