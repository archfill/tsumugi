const apply = process.argv.includes("--apply");
const expectedIndex = process.argv.indexOf("--expected-eligible");
const expectedEligible =
  expectedIndex >= 0 ? Number(process.argv[expectedIndex + 1]) : undefined;
if (
  apply &&
  (!Number.isInteger(expectedEligible) || (expectedEligible ?? -1) < 0)
) {
  process.stderr.write(
    `${JSON.stringify({ error: "--apply requires --expected-eligible <non-negative integer>" })}\n`,
  );
  process.exitCode = 2;
} else {
  const { retireLegacyCaptureWindows } = await import(
    "../../core/capture/retire-legacy.js"
  );
  const result = await retireLegacyCaptureWindows({ apply, expectedEligible });
  const output = JSON.stringify({ dryRun: !apply, ...result });
  if (apply && result.blocked) {
    process.stderr.write(`${output}\n`);
    process.exitCode = 3;
  } else {
    process.stdout.write(`${output}\n`);
  }
}
