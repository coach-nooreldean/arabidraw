export interface DrawingMetadata {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
}

export interface ServerDrawing extends DrawingMetadata {
  readonly scene: object;
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response;
  try {
    response = await fetch(`/api/drawings${path}`, init);
  } catch (error) {
    if (init?.signal?.aborted) {
      throw error;
    }
    console.error("Drawing server request failed", error);
    throw new Error(
      "Cannot reach the drawing server. Check your connection and try again.",
    );
  }
  let data;
  try {
    data = await response.json();
  } catch (error) {
    if (init?.signal?.aborted) {
      throw error;
    }
    console.error("Invalid drawing server response", error);
    throw new Error(
      "The drawing server returned an invalid response. Check that the server is running and try again.",
    );
  }
  if (!response.ok) {
    throw new Error(
      data.error ||
        `Drawing server request failed (${response.status}). Try again.`,
    );
  }
  return data as T;
};

export const listDrawings = () => request<DrawingMetadata[]>("");

export const getDrawing = (id: string, signal?: AbortSignal) =>
  request<ServerDrawing>(`/${encodeURIComponent(id)}`, { signal });

export const saveDrawing = (id: string | null, name: string, scene: object) =>
  request<DrawingMetadata>(id ? `/${encodeURIComponent(id)}` : "", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, scene }),
  });

export const deleteDrawing = (id: string) =>
  request<{ readonly id: string }>(`/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
