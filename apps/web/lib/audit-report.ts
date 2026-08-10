// Templated from measured sandbox output, not a second free-form LLM call
// — docs/04-ai-cleaning-and-audit.md is explicit about this: the numbers
// the user reads should reflect measured reality, not model commentary.
type FlaggedGap = { column: string; null_count: number; severity: string };
type Summary = {
  report: { unmapped_fields: string[]; flagged_gaps: FlaggedGap[] };
  measured: { input_row_count: number; output_row_count: number; output_columns: string[] };
};

export function renderAuditReportMarkdown(datasetName: string, summary: Summary): string {
  const { report, measured } = summary;
  const lines: string[] = [];

  lines.push(`# Audit Report — ${datasetName}`);
  lines.push("");
  lines.push(`Cleaned **${measured.output_row_count}** rows (from **${measured.input_row_count}** in the source file).`);
  lines.push("");

  const requiredMissing = report.flagged_gaps.filter((g) => g.severity === "required_missing");
  const unexpectedGaps = report.flagged_gaps.filter((g) => g.severity === "unexpected_gap");

  lines.push("## Required fields missing");
  if (requiredMissing.length === 0) {
    lines.push("None — every required field was populated on every row.");
  } else {
    for (const gap of requiredMissing) {
      lines.push(`- **${gap.column}**: missing on ${gap.null_count} row(s) — this is a required field.`);
    }
  }
  lines.push("");

  lines.push("## Other gaps worth a look");
  if (unexpectedGaps.length === 0) {
    lines.push("None.");
  } else {
    for (const gap of unexpectedGaps) {
      lines.push(`- **${gap.column}**: missing on ${gap.null_count} row(s).`);
    }
  }
  lines.push("");

  lines.push("## Unmapped target fields");
  if (report.unmapped_fields.length === 0) {
    lines.push("None — every target column could be derived from the source data.");
  } else {
    for (const field of report.unmapped_fields) {
      lines.push(`- ${field}`);
    }
  }

  return lines.join("\n");
}
