import { useEffect, useRef, useState } from "react";

import { getNonDeletedElements } from "@excalidraw/element";
import { exportToCanvas } from "@excalidraw/excalidraw";
import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";

import { getDrawing } from "../data/serverDrawings";

import styles from "./ServerDrawingPreview.module.scss";

import type { DrawingMetadata } from "../data/serverDrawings";

const MAX_PREVIEWS = 64;
const MAX_CONCURRENT_PREVIEWS = 2;
const PREVIEW_SIZE = 240;

type PreviewListener = (preview: string | null) => void;

type PreviewJob = {
  readonly key: string;
  readonly id: string;
  readonly abort: AbortController;
  readonly listeners: Set<PreviewListener>;
};

// Cache only small rasters, never scenes or their embedded full-size images.
const previews = new Map<string, string | null>();
const jobs = new Map<string, PreviewJob>();
const queue: PreviewJob[] = [];
let running = 0;

const renderPreview = async (job: PreviewJob) => {
  let preview: string | null = null;
  try {
    const drawing = await getDrawing(job.id, job.abort.signal);
    if (job.abort.signal.aborted) {
      return;
    }
    const restored = await loadFromBlob(
      new Blob([JSON.stringify(drawing.scene)], { type: "application/json" }),
      null,
      null,
    );
    if (job.abort.signal.aborted) {
      return;
    }
    const elements = getNonDeletedElements(restored.elements);
    for (const element of elements) {
      if (element.type === "image") {
        const file = element.fileId ? restored.files[element.fileId] : null;
        if (!file?.dataURL || !file.mimeType) {
          throw new Error("The saved drawing has a missing embedded image.");
        }
      }
    }
    const canvas = await exportToCanvas({
      elements,
      appState: {
        ...restored.appState,
        exportBackground: true,
        exportScale: 1,
      },
      files: restored.files,
      maxWidthOrHeight: PREVIEW_SIZE,
    });
    try {
      if (!job.abort.signal.aborted) {
        preview = canvas.toDataURL("image/png");
      }
    } finally {
      // Release the backing buffer without retaining a canvas in the cache.
      canvas.width = 0;
      canvas.height = 0;
    }
  } catch (error) {
    if (!job.abort.signal.aborted) {
      console.error(
        `Rendering saved drawing preview failed (${job.id})`,
        error,
      );
    }
  } finally {
    if (!job.abort.signal.aborted) {
      previews.set(job.key, preview);
      if (previews.size > MAX_PREVIEWS) {
        const oldest = previews.keys().next().value;
        if (oldest !== undefined) {
          previews.delete(oldest);
        }
      }
      for (const listener of job.listeners) {
        listener(preview);
      }
    }
    if (jobs.get(job.key) === job) {
      jobs.delete(job.key);
    }
    running--;
    runQueue();
  }
};

const runQueue = () => {
  while (running < MAX_CONCURRENT_PREVIEWS && queue.length > 0) {
    const job = queue.shift()!;
    running++;
    void renderPreview(job);
  }
};

const requestPreview = (key: string, id: string, listener: PreviewListener) => {
  const cached = previews.get(key);
  if (cached !== undefined) {
    previews.delete(key);
    previews.set(key, cached);
    listener(cached);
    return () => {};
  }
  let job = jobs.get(key);
  if (!job) {
    job = { key, id, abort: new AbortController(), listeners: new Set() };
    jobs.set(key, job);
    queue.push(job);
  }
  job.listeners.add(listener);
  runQueue();
  const subscribedJob = job;
  return () => {
    subscribedJob.listeners.delete(listener);
    if (subscribedJob.listeners.size === 0) {
      subscribedJob.abort.abort();
      const index = queue.indexOf(subscribedJob);
      if (index !== -1) {
        queue.splice(index, 1);
      }
      if (jobs.get(key) === subscribedJob) {
        jobs.delete(key);
      }
    }
  };
};

export const ServerDrawingPreview = ({
  drawing,
}: {
  drawing: DrawingMetadata;
}) => {
  const container = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{
    readonly key: string;
    readonly source: string | null;
  } | null>(null);
  const key = `${drawing.id}:${drawing.updatedAt}`;

  useEffect(() => {
    const node = container.current;
    if (!node) {
      return;
    }
    let mounted = true;
    let cancel: (() => void) | undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        cancel ??= requestPreview(key, drawing.id, (source) => {
          if (mounted) {
            setPreview({ key, source });
          }
        });
      } else {
        cancel?.();
        cancel = undefined;
        setPreview(null);
      }
    });
    observer.observe(node);
    return () => {
      mounted = false;
      observer.disconnect();
      cancel?.();
    };
  }, [drawing.id, key]);

  const source = preview?.key === key ? preview.source : undefined;
  return (
    <div ref={container} className={styles.preview}>
      {source ? (
        <img src={source} alt={`Preview of ${drawing.name}`} />
      ) : (
        <span>
          {source === null ? "Preview unavailable" : "Loading preview…"}
        </span>
      )}
    </div>
  );
};
