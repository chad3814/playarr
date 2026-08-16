import type {
  ApiError,
  CandidateFile,
  JobDto,
  JobFailure,
  JobStatus,
  NntpSecurity,
  SegmentRun,
  SelectionDto,
  SelectRequest,
  SettingsDto,
  SettingsTestResult,
  SettingsUpdate,
} from '@playarr/shared';

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

const JOB_STATUSES: readonly string[] = [
  'uploaded',
  'ready',
  'paused',
  'completing',
  'complete',
  'failed',
];

const NNTP_SECURITIES: readonly string[] = ['implicit', 'starttls', 'none'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && JOB_STATUSES.includes(value);
}

function isNntpSecurity(value: unknown): value is NntpSecurity {
  return typeof value === 'string' && NNTP_SECURITIES.includes(value);
}

function isApiError(value: unknown): value is ApiError {
  return isRecord(value) && isString(value['code']) && isString(value['message']);
}

function isCandidateFile(value: unknown): value is CandidateFile {
  return (
    isRecord(value) &&
    isNumber(value['fileIndex']) &&
    (value['subjectName'] === null || isString(value['subjectName'])) &&
    isNumber(value['encodedBytes']) &&
    isNumber(value['segmentCount']) &&
    isBoolean(value['selectable'])
  );
}

function isJobFailure(value: unknown): value is JobFailure {
  return isRecord(value) && isString(value['code']) && isString(value['message']);
}

function isSegmentRun(value: unknown): value is SegmentRun {
  return Array.isArray(value) && value.length === 2 && isNumber(value[0]) && isNumber(value[1]);
}

function isSelectionDto(value: unknown): value is SelectionDto {
  return (
    isRecord(value) &&
    isNumber(value['fileIndex']) &&
    isString(value['name']) &&
    isNumber(value['size']) &&
    isNumber(value['segmentSize']) &&
    isNumber(value['lastSegmentSize']) &&
    isNumber(value['segmentCount']) &&
    Array.isArray(value['covered']) &&
    value['covered'].every((entry) => isSegmentRun(entry)) &&
    Array.isArray(value['dead']) &&
    value['dead'].every((entry) => isNumber(entry)) &&
    isNumber(value['coveredBytes'])
  );
}

function isJobDto(value: unknown): value is JobDto {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isString(value['id']) &&
    isString(value['createdAt']) &&
    isString(value['nzbName']) &&
    isJobStatus(value['status']) &&
    isBoolean(value['active']) &&
    (value['failure'] === undefined || isJobFailure(value['failure'])) &&
    Array.isArray(value['candidates']) &&
    value['candidates'].every((entry) => isCandidateFile(entry)) &&
    isBoolean(value['namesUnresolved']) &&
    (value['selection'] === undefined || isSelectionDto(value['selection']))
  );
}

function isJobDtoArray(value: unknown): value is JobDto[] {
  return Array.isArray(value) && value.every((entry) => isJobDto(entry));
}

function isSettingsDto(value: unknown): value is SettingsDto {
  return (
    isRecord(value) &&
    isString(value['host']) &&
    isNumber(value['port']) &&
    isNntpSecurity(value['security']) &&
    isNumber(value['connections']) &&
    isString(value['username']) &&
    isBoolean(value['hasPassword']) &&
    isBoolean(value['passwordFromEnvironment'])
  );
}

function isSettingsTestResult(value: unknown): value is SettingsTestResult {
  return (
    isRecord(value) &&
    isBoolean(value['ok']) &&
    isString(value['message']) &&
    Array.isArray(value['failures']) &&
    value['failures'].every((entry) => isString(entry))
  );
}

/** Thrown when a response's shape does not match what the caller expects. */
function invalidResponse(path: string): never {
  throw new ApiRequestError(502, 'invalid-response', `Malformed response body from ${path}.`);
}

/**
 * A body that is not valid JSON (an HTML error page from a proxy, an empty
 * response) becomes `null` rather than throwing, so the caller always has a
 * defined `code`/`status` to report instead of an uncaught `SyntaxError`.
 */
function parseJsonBody(text: string): unknown {
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Fetch and decode a JSON body, mapping non-2xx responses to `ApiRequestError`.
 *
 * The body is returned as `unknown`: every caller below narrows it with a
 * real type guard before handing it back, so a server that starts returning
 * an unexpected shape fails loudly instead of producing bad data silently.
 */
async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  if (response.status === 204) {
    return null;
  }

  const body = parseJsonBody(await response.text());

  if (!response.ok) {
    const detail = isApiError(body) ? body : null;
    throw new ApiRequestError(
      response.status,
      detail?.code ?? 'error',
      detail?.message ?? response.statusText,
    );
  }
  return body;
}

function json(payload: unknown): RequestInit {
  return {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

export async function listJobs(): Promise<JobDto[]> {
  const body = await request('/api/jobs');
  return isJobDtoArray(body) ? body : invalidResponse('/api/jobs');
}

export async function getJob(id: string): Promise<JobDto> {
  const path = `/api/jobs/${id}`;
  const body = await request(path);
  return isJobDto(body) ? body : invalidResponse(path);
}

export async function uploadNzb(file: File): Promise<JobDto> {
  const form = new FormData();
  form.append('nzb', file);
  const body = await request('/api/jobs', { method: 'POST', body: form });
  return isJobDto(body) ? body : invalidResponse('/api/jobs');
}

export async function selectFile(id: string, fileIndex: number): Promise<JobDto> {
  const path = `/api/jobs/${id}/select`;
  const payload: SelectRequest = { fileIndex };
  const body = await request(path, { ...json(payload), method: 'POST' });
  return isJobDto(body) ? body : invalidResponse(path);
}

export async function completeJob(id: string): Promise<JobDto> {
  const path = `/api/jobs/${id}/complete`;
  const body = await request(path, { method: 'POST' });
  return isJobDto(body) ? body : invalidResponse(path);
}

export async function deleteJob(id: string): Promise<void> {
  await request(`/api/jobs/${id}`, { method: 'DELETE' });
}

export async function getSettings(): Promise<SettingsDto | null> {
  const body = await request('/api/settings');
  if (body === null) {
    return null;
  }
  return isSettingsDto(body) ? body : invalidResponse('/api/settings');
}

export async function saveSettings(update: SettingsUpdate): Promise<SettingsDto> {
  const body = await request('/api/settings', json(update));
  return isSettingsDto(body) ? body : invalidResponse('/api/settings');
}

export async function testSettings(): Promise<SettingsTestResult> {
  const body = await request('/api/settings/test', { method: 'POST' });
  return isSettingsTestResult(body) ? body : invalidResponse('/api/settings/test');
}
