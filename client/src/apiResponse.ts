export async function readApiResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  if (!body) return {} as T;
  try { return JSON.parse(body) as T; }
  catch {
    const detail = body.replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(`پاسخ API معتبر نیست (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
  }
}
