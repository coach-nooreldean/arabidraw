import { Dialog } from "@excalidraw/excalidraw/components/Dialog";

import { ServerDrawingPreview } from "./ServerDrawingPreview";

import styles from "./ServerDrawingsDialog.module.scss";

import type { ServerDrawingsController } from "../useServerDrawings";

export const ServerDrawingsDialog = ({
  drawings: controller,
}: {
  drawings: ServerDrawingsController;
}) => {
  if (!controller.isOpen) {
    return null;
  }

  const disabled = controller.disabled || controller.operation !== null;

  return (
    <Dialog
      title="Server drawings"
      size="regular"
      onCloseRequest={controller.close}
    >
      <div className={styles.content}>
        <p aria-live="polite" className={styles.status}>
          <strong>{controller.activeDrawing?.name ?? "Unsaved drawing"}</strong>
          <span>
            {controller.isDirty ? "Unsaved changes" : "Saved to server"}
          </span>
        </p>
        {controller.disabled && (
          <p role="status">
            Server drawing actions are unavailable during collaboration. Leave
            the collaboration session to use them.
          </p>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            disabled={
              disabled || (!controller.activeDrawing && !controller.name.trim())
            }
            onClick={() => void controller.save(false)}
          >
            Save
          </button>
          {controller.activeDrawing && (
            <span>Update “{controller.activeDrawing.name}”</span>
          )}
        </div>
        <form
          className={styles.saveAs}
          onSubmit={(event) => {
            event.preventDefault();
            void controller.save(true);
          }}
        >
          <label htmlFor="server-drawing-name">Drawing name</label>
          <div className={styles.actions}>
            <input
              id="server-drawing-name"
              type="text"
              value={controller.name}
              maxLength={200}
              disabled={disabled}
              onChange={(event) => controller.setName(event.target.value)}
            />
            <button
              type="submit"
              disabled={disabled || !controller.name.trim()}
            >
              Save as
            </button>
          </div>
          <span>
            Save as creates a separate drawing. Files are stored on this server.
          </span>
        </form>
        {controller.operation && (
          <p role="status">
            {controller.operation === "save"
              ? "Saving drawing…"
              : controller.operation === "delete"
              ? "Deleting drawing…"
              : "Loading drawing…"}
          </p>
        )}
        {controller.error && (
          <p role="alert" className={styles.error}>
            {controller.error}
          </p>
        )}
        <section
          aria-labelledby="server-drawings-heading"
          className={styles.browser}
        >
          <div className={styles.actions}>
            <h3 id="server-drawings-heading">Browse drawings</h3>
            <button
              type="button"
              disabled={controller.isListing || controller.operation !== null}
              onClick={() => void controller.refresh()}
            >
              Refresh
            </button>
          </div>
          {controller.isListing && <p role="status">Loading drawing list…</p>}
          {controller.listError && (
            <p role="alert" className={styles.error}>
              {controller.listError}
            </p>
          )}
          {!controller.isListing &&
            !controller.listError &&
            controller.drawings.length === 0 && (
              <p>
                No saved drawings yet. Enter a name and choose Save as to create
                one.
              </p>
            )}
          <ul className={styles.list} aria-busy={controller.isListing}>
            {controller.drawings.map((drawing) => (
              <li
                key={drawing.id}
                data-active={drawing.id === controller.activeDrawing?.id}
              >
                <ServerDrawingPreview drawing={drawing} />
                <div className={styles.details}>
                  <div className={styles.cardTitle}>
                    <strong>{drawing.name}</strong>
                    {drawing.id === controller.activeDrawing?.id && (
                      <span className={styles.activeBadge}>Active</span>
                    )}
                  </div>
                  <time dateTime={drawing.updatedAt}>
                    Modified {new Date(drawing.updatedAt).toLocaleString()}
                  </time>
                </div>
                <div className={styles.cardActions}>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`Load ${drawing.name}`}
                    onClick={() => void controller.load(drawing)}
                  >
                    Load
                  </button>
                  <button
                    type="button"
                    disabled={disabled}
                    className={styles.delete}
                    aria-label={`Delete ${drawing.name}`}
                    onClick={() => void controller.remove(drawing)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
        <div className={styles.actions}>
          <button type="button" onClick={controller.close}>
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
};
