import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import type { IncomingMessage, ServerResponse } from "node:http";

const DRAWINGS_DIR = path.resolve(process.env.DRAWINGS_DIR ?? "./drawings");
const MAX_BODY_BYTES = 50 * 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Scene extends Record<string, unknown> {
  type: "excalidraw";
  version: number;
  elements: Record<string, unknown>[];
  appState: Record<string, unknown>;
  files?: Record<string, unknown>;
}

interface DrawingMetadata {
  id: string;
  name: string;
  updatedAt: string;
  revision: string;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isScene = (value: unknown): value is Scene =>
  isObject(value) &&
  value.type === "excalidraw" &&
  Number.isInteger(value.version) &&
  (value.version as number) > 0 &&
  Array.isArray(value.elements) &&
  value.elements.every(isObject) &&
  isObject(value.appState) &&
  (value.files === undefined || isObject(value.files));

const isMissing = (error: unknown) =>
  (error as NodeJS.ErrnoException)?.code === "ENOENT";

const drawingPath = (id: string) => path.join(DRAWINGS_DIR, `${id}.excalidraw`);

const drawingMutations = new Map<string, Promise<void>>();

const mutateDrawing = async <T>(
  id: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const previous = drawingMutations.get(id);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  drawingMutations.set(id, pending);
  try {
    await previous;
    return await operation();
  } finally {
    release();
    if (drawingMutations.get(id) === pending) {
      drawingMutations.delete(id);
    }
  }
};

const sendJson = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
};

const readBody = (request: IncomingMessage): Promise<unknown> => {
  if (
    request.headers["content-type"]?.split(";")[0].trim() !== "application/json"
  ) {
    request.resume();
    return Promise.reject(
      new HttpError(415, "Content-Type must be application/json"),
    );
  }
  if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) {
    request.resume();
    return Promise.reject(
      new HttpError(413, "Drawing exceeds the 50 MB request limit"),
    );
  }

  // Node 20 does not provide Promise.withResolvers().
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    request.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        reject(new HttpError(413, "Drawing exceeds the 50 MB request limit"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        resolve(JSON.parse(Buffer.concat(chunks, size).toString("utf8")));
      } catch {
        reject(new HttpError(400, "Request body must be valid JSON"));
      }
    });
    request.on("error", reject);
    request.on("aborted", () =>
      reject(new HttpError(400, "Request was interrupted")),
    );
  });
};

const parseDrawing = (body: unknown): { name: string; scene: Scene } => {
  if (!isObject(body) || typeof body.name !== "string") {
    throw new HttpError(400, "A drawing name and scene are required");
  }
  const name = body.name.trim();
  if (!name || name.length > 200) {
    throw new HttpError(400, "Drawing name must contain 1 to 200 characters");
  }
  if (!isScene(body.scene)) {
    throw new HttpError(400, "Scene must be a valid Excalidraw document");
  }
  body.scene.appState.name = name;
  return { name, scene: body.scene };
};

const readDrawing = async (id: string) => {
  const filePath = drawingPath(id);
  let file;
  try {
    file = await open(filePath, "r");
  } catch (error) {
    if (isMissing(error)) {
      throw new HttpError(404, "Drawing not found");
    }
    throw error;
  }
  try {
    // Read and stat the same inode, even if a concurrent save replaces its path.
    const contents = await file.readFile("utf8");
    const scene: unknown = JSON.parse(contents);
    if (!isScene(scene) || typeof scene.appState.name !== "string") {
      throw new Error(`Invalid drawing document: ${filePath}`);
    }
    const stat = await file.stat();
    return {
      id,
      name: scene.appState.name,
      updatedAt: stat.mtime.toISOString(),
      revision: createHash("sha256").update(contents).digest("hex"),
      scene,
    };
  } finally {
    await file.close();
  }
};

const listDrawings = async (): Promise<DrawingMetadata[]> => {
  const drawings: DrawingMetadata[] = [];
  for (const entry of await readdir(DRAWINGS_DIR, { withFileTypes: true })) {
    if (!entry.name.endsWith(".excalidraw")) {
      continue;
    }
    const id = entry.name.slice(0, -".excalidraw".length);
    if (!entry.isFile() || !UUID_PATTERN.test(id)) {
      console.error(
        `Ignoring invalid drawing file: ${path.join(DRAWINGS_DIR, entry.name)}`,
      );
      continue;
    }
    try {
      const { name, updatedAt, revision } = await readDrawing(id);
      drawings.push({ id, name, updatedAt, revision });
    } catch (error) {
      console.error(`Unable to list drawing ${drawingPath(id)}:`, error);
    }
  }
  drawings.sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
  );
  return drawings;
};

const saveDrawing = (
  id: string,
  name: string,
  scene: Scene,
  expectedRevision?: string,
): Promise<DrawingMetadata> =>
  mutateDrawing(id, async () => {
    if (expectedRevision !== undefined) {
      await checkRevision(id, expectedRevision);
    } else {
      // A retry after a lost response must not create a second drawing.
      try {
        const existing = await readDrawing(id);
        if (
          existing.revision !==
          createHash("sha256").update(JSON.stringify(scene)).digest("hex")
        ) {
          throw new HttpError(
            409,
            "This save request was already used for a different drawing.",
          );
        }
        const { scene: _scene, ...metadata } = existing;
        return metadata;
      } catch (error) {
        if (!(error instanceof HttpError) || error.status !== 404) {
          throw error;
        }
      }
    }
    const temporaryPath = path.join(DRAWINGS_DIR, `.${id}.${randomUUID()}.tmp`);
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      let updatedAt: string;
      try {
        await file.writeFile(JSON.stringify(scene), "utf8");
        await file.sync();
        updatedAt = (await file.stat()).mtime.toISOString();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, drawingPath(id));
      return {
        id,
        name,
        updatedAt,
        revision: createHash("sha256")
          .update(JSON.stringify(scene))
          .digest("hex"),
      };
    } finally {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (!isMissing(error)) {
          console.error(
            `Unable to clean temporary drawing ${temporaryPath}:`,
            error,
          );
        }
      }
    }
  });

const checkRevision = async (id: string, expectedRevision: string) => {
  const current = await readDrawing(id);
  if (`"${current.revision}"` !== expectedRevision) {
    throw new HttpError(
      409,
      "This drawing changed on the server. Load the latest version or use Save as to keep your changes in a separate copy.",
    );
  }
};

const requireRevision = (request: IncomingMessage) => {
  const revision = request.headers["if-match"];
  if (typeof revision !== "string" || !/^"[0-9a-f]{64}"$/.test(revision)) {
    throw new HttpError(
      428,
      "Load this drawing before updating or deleting it.",
    );
  }
  return revision;
};

const deleteDrawing = (id: string, revision: string): Promise<void> =>
  mutateDrawing(id, async () => {
    try {
      await checkRevision(id, revision);
      await unlink(drawingPath(id));
    } catch (error) {
      if (isMissing(error)) {
        throw new HttpError(404, "Drawing not found");
      }
      throw error;
    }
  });

const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
) => {
  try {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/drawings") {
      if (request.method === "GET") {
        sendJson(response, 200, await listDrawings());
        return;
      }
      if (request.method === "POST") {
        const { name, scene } = parseDrawing(await readBody(request));
        const requestId = request.headers["idempotency-key"];
        if (
          requestId !== undefined &&
          (typeof requestId !== "string" || !UUID_PATTERN.test(requestId))
        ) {
          throw new HttpError(400, "Invalid save request ID");
        }
        const drawing = await saveDrawing(
          typeof requestId === "string"
            ? requestId.toLowerCase()
            : randomUUID(),
          name,
          scene,
        );
        response.setHeader("Location", `/api/drawings/${drawing.id}`);
        sendJson(response, 201, drawing);
        return;
      }
      response.setHeader("Allow", "GET, POST");
      throw new HttpError(405, "Method not allowed");
    }

    const match = /^\/api\/drawings\/([^/]+)$/.exec(pathname);
    if (!match) {
      throw new HttpError(404, "Endpoint not found");
    }
    const id = match[1].toLowerCase();
    if (!UUID_PATTERN.test(id)) {
      throw new HttpError(400, "Invalid drawing ID");
    }
    if (request.method === "GET") {
      sendJson(response, 200, await readDrawing(id));
      return;
    }
    if (request.method === "PUT") {
      const { name, scene } = parseDrawing(await readBody(request));
      sendJson(
        response,
        200,
        await saveDrawing(id, name, scene, requireRevision(request)),
      );
      return;
    }
    if (request.method === "DELETE") {
      await deleteDrawing(id, requireRevision(request));
      sendJson(response, 200, { id });
      return;
    }
    response.setHeader("Allow", "GET, PUT, DELETE");
    throw new HttpError(405, "Method not allowed");
  } catch (error) {
    if (!(error instanceof HttpError)) {
      console.error(
        `Drawing API ${request.method} ${request.url} failed:`,
        error,
      );
    }
    if (!response.destroyed) {
      sendJson(response, error instanceof HttpError ? error.status : 500, {
        error:
          error instanceof HttpError
            ? error.message
            : "Unable to access drawing storage",
      });
    }
  }
};

const start = async () => {
  await mkdir(DRAWINGS_DIR, { recursive: true });
  const port = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.requestTimeout = 120_000;
  server.on("error", (error) => {
    console.error("Drawing API server failed:", error);
    process.exitCode = 1;
  });
  server.listen(port, process.env.HOST ?? "0.0.0.0", () => {
    console.info(
      `Drawing API listening on port ${port}; storage: ${DRAWINGS_DIR}`,
    );
  });
};

void start().catch((error) => {
  console.error("Unable to start drawing API:", error);
  process.exitCode = 1;
});
