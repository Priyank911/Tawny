import { app } from 'electron';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ErrorClass, PipelineLog, Stage, LogLevel } from '../shared/contracts';

type LogSink = (entry: PipelineLog) => void;
let sink: LogSink | undefined;
const recent: PipelineLog[] = [];

export function setLogSink(next: LogSink): void {
  sink = next;
}

export function getRecentLogs(): PipelineLog[] {
  return [...recent];
}

export function logPipeline(input: {
  level?: LogLevel;
  event: string;
  message: string;
  jobId?: string;
  stage?: Stage;
  provider?: string;
  durationMs?: number;
  errorClass?: ErrorClass;
  data?: Record<string, string>;
}): void {
  const entry: PipelineLog = {
    timestamp: new Date().toISOString(),
    level: input.level ?? 'info',
    event: input.event,
    message: input.message,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    ...(input.stage ? { stage: input.stage } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    ...(input.errorClass ? { errorClass: input.errorClass } : {}),
    ...(input.data ? { data: input.data } : {})
  };
  recent.push(entry);
  if (recent.length > 200) recent.shift();
  sink?.(entry);
  const line = `${JSON.stringify(entry)}\n`;
  void mkdir(join(app.getPath('userData'), 'logs'), { recursive: true })
    .then(() => appendFile(join(app.getPath('userData'), 'logs', 'pipeline.jsonl'), line, 'utf8'))
    .catch((error: unknown) => console.error('Unable to write Tawny pipeline log.', error));
  if (input.level !== 'debug') console.log(`[Tawny:${entry.event}] ${entry.message}`);
}
