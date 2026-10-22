export interface DrawingMetadata {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly revision: string;
}

export interface ServerDrawing extends DrawingMetadata {
  readonly scene: object;
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  if (init?.signal?.aborted) {
    abort.abort();
  }
  init?.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = window.setTimeout(() => abort.abort(), 30_000);
  try {
    let response: Response;
    try {
      response = await fetch(`/api/drawings${path}`, {
        ...init,
        signal: abort.signal,
      });
    } catch (error) {
      if (init?.signal?.aborted) {
        throw error;
      }
      throw new Error(
        abort.signal.aborted
          ? "The drawing server took too long to respond. Check your connection and try again."
          : "Cannot reach the drawing server. Check your connection and try again.",
      );
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      if (init?.signal?.aborted) {
        throw error;
      }
      throw new Error(
        abort.signal.aborted
          ? "The drawing server took too long to respond. Check your connection and try again."
          : "The drawing server returned an invalid response. Check that the server is running and try again.",
      );
    }
    if (!response.ok) {
      throw new Error(
        data?.error ||
          `Drawing server request failed (${response.status}). Try again.`,
      );
    }
    return data as T;
  } finally {
    window.clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", onAbort);
  }
};

export const listDrawings = () => request<DrawingMetadata[]>("");

export const getDrawing = (id: string, signal?: AbortSignal) =>
  request<ServerDrawing>(`/${encodeURIComponent(id)}`, { signal });

export const saveDrawing = (
  drawing: DrawingMetadata | null,
  name: string,
  scene: object,
  requestId?: string,
) =>
  request<DrawingMetadata>(
    drawing ? `/${encodeURIComponent(drawing.id)}` : "",
    {
      method: drawing ? "PUT" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(drawing
          ? { "If-Match": `"${drawing.revision}"` }
          : requestId
          ? { "Idempotency-Key": requestId }
          : {}),
      },
      body: JSON.stringify({ name, scene }),
    },
  );

export const deleteDrawing = (drawing: DrawingMetadata) =>
  request<{ readonly id: string }>(`/${encodeURIComponent(drawing.id)}`, {
    method: "DELETE",
    headers: { "If-Match": `"${drawing.revision}"` },
  });
