// Client for the FastAPI ai-service. Per docs/01-architecture.md, Next.js
// is the only thing that talks to Postgres — ai-service never does, so
// every call here sends whatever DB-derived context ai-service needs and
// gets back plain results for this app to persist.
const AI_SERVICE_URL = process.env.AI_SERVICE_URL || "http://localhost:8000";

export type SourceColumn = {
  name: string;
  inferred_dtype: string;
  null_pct: number;
  sample_values: string[];
};

type TargetColumnForApi = {
  name: string;
  type: string;
  required: boolean;
  structurallyOptional: boolean;
  description: string;
};

type CleaningRuleForApi = { rule: string; description: string };

export class AiServiceError extends Error {
  constructor(message: string, public detail?: unknown) {
    super(message);
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${AI_SERVICE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new AiServiceError(`ai-service ${path} failed with ${res.status}`, detail);
  }
  return res.json() as Promise<T>;
}

export function inferSchema(inputRelativePath: string, originalFilename: string) {
  return postJson<{ source_schema: SourceColumn[] }>("/schema/infer", {
    input_relative_path: inputRelativePath,
    original_filename: originalFilename,
  });
}

export function executeCleaning(params: {
  sourceSchema: SourceColumn[];
  targetSchema: TargetColumnForApi[];
  cleaningRules: CleaningRuleForApi[];
  inputRelativePath: string;
  originalFilename: string;
  outputRelativeDir: string;
}) {
  return postJson<{
    code: string;
    base_url: string;
    model: string;
    cleaned_file_relative_path: string;
    report: { unmapped_fields: string[]; flagged_gaps: { column: string; null_count: number; severity: string }[] };
    measured: { input_row_count: number; output_row_count: number; output_columns: string[] };
    sandbox_logs: string;
  }>("/clean/execute", {
    source_schema: params.sourceSchema,
    target_schema: params.targetSchema,
    cleaning_rules: params.cleaningRules,
    input_relative_path: params.inputRelativePath,
    original_filename: params.originalFilename,
    output_relative_dir: params.outputRelativeDir,
  });
}
