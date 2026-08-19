import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_GENERATED_WARNING = {
  code: "UNSAFE_VAR_ASSIGNMENT",
  file: "popup/popup.js",
  count: 3,
};

function normalizedFile(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function messages(report, type) {
  const value = report?.[type];
  return Array.isArray(value) ? value : [];
}

function describeMessage(message) {
  const location = [message.file, message.line, message.column]
    .filter(value => value !== undefined && value !== null && value !== "")
    .join(":");
  return `${message.code ?? "UNKNOWN"}${location ? ` (${location})` : ""}: ${message.message ?? message.description ?? "no message"}`;
}

/**
 * Keep Firefox lint strict while acknowledging a narrowly-scoped warning from
 * the generated React production bundle. The extension source itself never
 * assigns innerHTML; addons-linter sees ReactDOM's generated runtime helpers in
 * dist/popup/popup.js. Any new warning code, file, or count remains fatal.
 */
export function assertAcceptedLintReport(report) {
  const errors = messages(report, "errors");
  if (errors.length > 0) {
    throw new Error(`web-ext reported errors:\n${errors.map(describeMessage).join("\n")}`);
  }

  const warnings = messages(report, "warnings");
  const allowed = warnings.filter(warning =>
    warning?.code === ALLOWED_GENERATED_WARNING.code
    && normalizedFile(warning?.file) === ALLOWED_GENERATED_WARNING.file);
  const unexpected = warnings.filter(warning => !allowed.includes(warning));

  if (unexpected.length > 0) {
    throw new Error(`web-ext reported unexpected warnings:\n${unexpected.map(describeMessage).join("\n")}`);
  }
  if (allowed.length !== ALLOWED_GENERATED_WARNING.count) {
    throw new Error(
      `Expected exactly ${ALLOWED_GENERATED_WARNING.count} ${ALLOWED_GENERATED_WARNING.code} warnings in ${ALLOWED_GENERATED_WARNING.file}, received ${allowed.length}. Review the generated bundle before changing this policy.`,
    );
  }

  return {
    errors: errors.length,
    warnings: warnings.length,
    notices: messages(report, "notices").length,
    allowedGeneratedWarnings: allowed.length,
  };
}

function parseReport(stdout, stderr) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `web-ext did not return valid JSON: ${error instanceof Error ? error.message : String(error)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  }
}

export function runLint() {
  const webExtBin = resolve("node_modules", "web-ext", "bin", "web-ext.js");
  const result = spawnSync(
    process.execPath,
    [webExtBin, "lint", "--source-dir", "dist", "--output", "json"],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;

  const report = parseReport(result.stdout ?? "", result.stderr ?? "");
  const summary = assertAcceptedLintReport(report);

  // Without --warnings-as-errors, web-ext should exit zero for the three known
  // generated warnings. A non-zero exit after the report passed our policy is
  // therefore an infrastructure/linter failure, not something to ignore.
  if (result.status !== 0) {
    throw new Error(
      `web-ext exited with status ${result.status} even though its JSON report passed policy.\nstderr:\n${result.stderr ?? ""}`,
    );
  }

  console.log(
    `web-ext lint passed: ${summary.errors} error(s), ${summary.notices} notice(s), ${summary.warnings} warning(s); ${summary.allowedGeneratedWarnings} warning(s) are the pinned ReactDOM bundle false-positive policy.`,
  );
}

const currentScript = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (currentScript === fileURLToPath(import.meta.url)) {
  try {
    runLint();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
