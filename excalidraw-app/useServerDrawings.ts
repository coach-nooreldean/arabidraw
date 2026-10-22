import { useCallback, useEffect, useRef, useState } from "react";

import { CaptureUpdateAction } from "@excalidraw/excalidraw";
import { cleanAppStateForExport } from "@excalidraw/excalidraw/appState";
import { loadFromBlob } from "@excalidraw/excalidraw/data/blob";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";

import type { ExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import {
  deleteDrawing,
  getDrawing,
  listDrawings,
  saveDrawing,
} from "./data/serverDrawings";

import type { DrawingMetadata } from "./data/serverDrawings";

export interface ServerDrawingsController {
  readonly isOpen: boolean;
  readonly activeDrawing: DrawingMetadata | null;
  readonly isDirty: boolean;
  readonly drawings: readonly DrawingMetadata[];
  readonly isListing: boolean;
  readonly operation: "save" | "load" | "delete" | null;
  readonly error: string;
  readonly listError: string;
  readonly name: string;
  readonly disabled: boolean;
  open(): void;
  close(): void;
  setName(name: string): void;
  refresh(): Promise<void>;
  save(saveAs: boolean): Promise<void>;
  load(drawing: DrawingMetadata): Promise<void>;
  remove(drawing: DrawingMetadata): Promise<void>;
}

// Ignore editor chrome, image-cache status and element revision bookkeeping.
// Cache the expensive content snapshot so panning/selection never re-encodes images.
const createContentTracker = () => {
  let previousElements: { id: string; version: number; deleted: boolean }[] =
    [];
  let previousFiles: { id: string; dataURL: string; mimeType: string }[] = [];
  let previousAppState = "";
  let content = "";

  return (
    elements: readonly ExcalidrawElement[],
    appState: Partial<AppState>,
    files: BinaryFiles,
  ) => {
    const exportedAppState = cleanAppStateForExport(appState);
    const state = JSON.stringify(exportedAppState);
    let changed =
      state !== previousAppState || elements.length !== previousElements.length;
    let fileIndex = 0;
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index];
      const previous = previousElements[index];
      if (
        previous?.id !== element.id ||
        previous.version !== element.version ||
        previous.deleted !== element.isDeleted
      ) {
        changed = true;
      }
      if (!element.isDeleted && element.type === "image" && element.fileId) {
        const file = files[element.fileId];
        if (file) {
          const previousFile = previousFiles[fileIndex++];
          if (
            previousFile?.id !== file.id ||
            previousFile.dataURL !== file.dataURL ||
            previousFile.mimeType !== file.mimeType
          ) {
            changed = true;
          }
        }
      }
    }
    if (!changed && fileIndex === previousFiles.length) {
      return content;
    }
    previousAppState = state;
    previousElements = elements.map((element) => ({
      id: element.id,
      version: element.version,
      deleted: element.isDeleted,
    }));
    previousFiles = [];
    const visibleElements = [];
    for (const element of elements) {
      if (element.isDeleted) {
        continue;
      }
      visibleElements.push({
        ...element,
        version: undefined,
        versionNonce: undefined,
        updated: undefined,
        ...(element.type === "image" ? { status: undefined } : {}),
      });
      if (element.type === "image" && element.fileId && files[element.fileId]) {
        const file = files[element.fileId];
        previousFiles.push({
          id: file.id,
          dataURL: file.dataURL,
          mimeType: file.mimeType,
        });
      }
    }
    content = JSON.stringify({
      elements: visibleElements,
      appState: exportedAppState,
      files: previousFiles,
    });
    return content;
  };
};

const ACTIVE_DRAWING_KEY = "arabidraw-active-drawing";

const readActiveDrawing = (): DrawingMetadata | null => {
  try {
    const value = JSON.parse(
      localStorage.getItem(ACTIVE_DRAWING_KEY) ?? "null",
    );
    return value &&
      typeof value.id === "string" &&
      typeof value.name === "string" &&
      typeof value.updatedAt === "string"
      ? value
      : null;
  } catch (error) {
    console.error("Reading active server drawing failed", error);
    return null;
  }
};

export const useServerDrawings = (
  api: ExcalidrawImperativeAPI | null,
  isCollaborating: boolean,
): ServerDrawingsController => {
  const [isOpen, setIsOpen] = useState(false);
  const [activeDrawing, setActiveDrawing] = useState<DrawingMetadata | null>(
    readActiveDrawing,
  );
  const [isDirty, setIsDirty] = useState(true);
  const [drawings, setDrawings] = useState<readonly DrawingMetadata[]>([]);
  const [isListing, setIsListing] = useState(false);
  const [operation, setOperation] =
    useState<ServerDrawingsController["operation"]>(null);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [name, setName] = useState("");
  const savedContent = useRef<string | null>(null);
  const [trackContent] = useState(createContentTracker);
  const busy = useRef(false);
  const collaboration = useRef(isCollaborating);
  const listRequest = useRef(0);
  collaboration.current = isCollaborating;

  useEffect(() => {
    try {
      if (activeDrawing) {
        const { id, name, updatedAt } = activeDrawing;
        localStorage.setItem(
          ACTIVE_DRAWING_KEY,
          JSON.stringify({ id, name, updatedAt }),
        );
      } else {
        localStorage.removeItem(ACTIVE_DRAWING_KEY);
      }
    } catch (error) {
      console.error("Persisting active server drawing failed", error);
      setError(
        "The browser could not remember the active drawing. Load it again after refreshing before saving.",
      );
    }
  }, [activeDrawing]);

  const currentContent = useCallback(() => {
    if (!api) {
      return "";
    }
    return trackContent(
      api.getSceneElements(),
      api.getAppState(),
      api.getFiles(),
    );
  }, [api, trackContent]);

  useEffect(() => {
    if (!api) {
      return;
    }
    // A browser-restored canvas has not yet been saved to the server.
    const update = () =>
      setIsDirty(
        savedContent.current === null ||
          currentContent() !== savedContent.current,
      );
    update();
    return api.onChange(update);
  }, [api, currentContent]);

  useEffect(() => {
    if (!activeDrawing) {
      return;
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!collaboration.current && currentContent() !== savedContent.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [activeDrawing, currentContent]);

  const refresh = useCallback(async () => {
    const request = ++listRequest.current;
    setIsListing(true);
    setListError("");
    try {
      const result = await listDrawings();
      if (request === listRequest.current) {
        setDrawings(result);
      }
    } catch (error) {
      console.error("Listing server drawings failed", error);
      if (request === listRequest.current) {
        setListError(
          error instanceof Error
            ? error.message
            : "Could not list drawings. Try refreshing.",
        );
      }
    } finally {
      if (request === listRequest.current) {
        setIsListing(false);
      }
    }
  }, []);

  const open = () => {
    setIsOpen(true);
    setName(activeDrawing?.name ?? api?.getName() ?? "");
    setError("");
    void refresh();
  };

  const save = async (saveAs: boolean) => {
    if (!api || busy.current || collaboration.current) {
      return;
    }
    const drawingName = (saveAs ? name : activeDrawing?.name ?? name).trim();
    if (!drawingName) {
      setError("Enter a name for your drawing.");
      return;
    }
    busy.current = true;
    ++listRequest.current;
    setIsListing(false);
    setOperation("save");
    setError("");
    try {
      for (const element of api.getSceneElements()) {
        if (
          element.type === "image" &&
          (!element.fileId || !api.getFiles()[element.fileId])
        ) {
          throw new Error(
            "An image is still loading or unavailable. Wait for it to load, or remove the missing image before saving.",
          );
        }
      }
      const snapshot = currentContent();
      const scene = JSON.parse(
        serializeAsJSON(
          api.getSceneElements(),
          api.getAppState(),
          api.getFiles(),
          "local",
        ),
      );
      scene.appState.name = drawingName;
      const result = await saveDrawing(
        saveAs ? null : activeDrawing?.id ?? null,
        drawingName,
        scene,
      );
      void refresh();
      if (collaboration.current) {
        setError(
          `Saved “${result.name}”, but the active canvas is now in collaboration. Leave collaboration before loading it.`,
        );
        return;
      }
      savedContent.current = snapshot;
      setActiveDrawing(result);
      setName(result.name);
      setIsDirty(currentContent() !== snapshot);
      api.updateScene({
        appState: { name: result.name },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    } catch (error) {
      console.error("Saving server drawing failed", error);
      setError(
        error instanceof Error
          ? error.message
          : "Could not save the drawing. Try again.",
      );
      setIsOpen(true);
    } finally {
      busy.current = false;
      setOperation(null);
    }
  };

  const load = async (drawing: DrawingMetadata) => {
    if (!api || busy.current || collaboration.current) {
      return;
    }
    const before = currentContent();
    if (
      (savedContent.current === null || before !== savedContent.current) &&
      !window.confirm(
        "This canvas has unsaved changes. Load another drawing and discard them?",
      )
    ) {
      return;
    }
    busy.current = true;
    setOperation("load");
    setError("");
    try {
      const result = await getDrawing(drawing.id);
      const restored = await loadFromBlob(
        new Blob([JSON.stringify(result.scene)], { type: "application/json" }),
        api.getAppState(),
        null,
      );
      for (const element of restored.elements) {
        if (!element.isDeleted && element.type === "image") {
          const file = element.fileId ? restored.files[element.fileId] : null;
          if (
            !file ||
            typeof file.dataURL !== "string" ||
            typeof file.mimeType !== "string"
          ) {
            throw new Error(
              "This drawing contains a missing or invalid embedded image. Your canvas has not been replaced.",
            );
          }
        }
      }
      if (collaboration.current) {
        setError(
          "Loading was cancelled because collaboration started. Leave collaboration and try again.",
        );
        return;
      }
      if (
        currentContent() !== before &&
        !window.confirm(
          "The canvas changed while this drawing was loading. Discard those new changes and continue?",
        )
      ) {
        return;
      }
      const appState = {
        ...restored.appState,
        name: result.name,
        selectedElementIds: {},
        selectedGroupIds: {},
        editingGroupId: null,
        openDialog: null,
        fileHandle: null,
      };
      savedContent.current = trackContent(
        restored.elements,
        appState,
        restored.files,
      );
      api.updateScene({
        elements: restored.elements,
        appState,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      api.addFiles(Object.values(restored.files));
      api.history.clear();
      setActiveDrawing(result);
      setName(result.name);
      setIsDirty(false);
      setIsOpen(false);
    } catch (error) {
      console.error("Loading server drawing failed", error);
      setError(
        error instanceof Error
          ? error.message
          : "Could not load the drawing. Your canvas has not been replaced.",
      );
      setIsOpen(true);
    } finally {
      busy.current = false;
      setOperation(null);
    }
  };

  const remove = async (drawing: DrawingMetadata) => {
    if (!api || busy.current || collaboration.current) {
      return;
    }
    if (
      !window.confirm(
        `Delete “${drawing.name}” from the server? This cannot be undone. Your current canvas will stay unchanged.`,
      )
    ) {
      return;
    }
    busy.current = true;
    ++listRequest.current;
    setIsListing(false);
    setOperation("delete");
    setError("");
    try {
      await deleteDrawing(drawing.id);
      setDrawings((current) =>
        current.filter((item) => item.id !== drawing.id),
      );
      if (activeDrawing?.id === drawing.id) {
        savedContent.current = null;
        setActiveDrawing(null);
        setIsDirty(true);
      }
      void refresh();
    } catch (error) {
      console.error("Deleting server drawing failed", error);
      setError(
        `Could not delete “${drawing.name}”. ${
          error instanceof Error ? error.message : ""
        } Refresh the list and try again.`,
      );
      setIsOpen(true);
    } finally {
      busy.current = false;
      setOperation(null);
    }
  };

  return {
    isOpen,
    open,
    close: () => setIsOpen(false),
    activeDrawing,
    isDirty,
    drawings,
    isListing,
    operation,
    error,
    listError,
    name,
    setName,
    refresh,
    save,
    load,
    remove,
    disabled: !api || isCollaborating,
  };
};
