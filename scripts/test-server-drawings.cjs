/* Browser/API regression tests. Always creates its own servers and temporary storage. */
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const children = [];
let browser;
let temporary;
let page;
const start = (command, args, options = {}) => {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  children.push(child);
  child.output = "";
  child.stdout.on("data", (chunk) => {
    child.output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    child.output += chunk;
  });
  return child;
};
const freePort = async () => {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};
const waitForServer = async (url, child) => {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(child.output);
    }
    try {
      if ((await fetch(url)).ok) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not start: ${child.output}`);
};
const test = async (name, run) => {
  await run();
  console.log(`PASS ${name}`);
};
const dialog = (p = page) =>
  p.getByRole("dialog", { name: "Server drawings", exact: true });
const openGallery = async (p = page) => {
  await p.getByRole("button", { name: "Drawings", exact: true }).click();
  await dialog(p).waitFor();
};
const closeGallery = async (p = page) => {
  await dialog(p).getByRole("button", { name: "Close", exact: true }).click();
  await dialog(p).waitFor({ state: "hidden" });
};
const identity = (p = page) => p.evaluate(() => window.h.state.serverDrawing);
const persisted = (p = page) =>
  p.waitForFunction(() => {
    const stored = JSON.parse(localStorage.getItem("excalidraw-state"));
    return (
      stored?.serverDrawing?.revision ===
        window.h.state.serverDrawing?.revision &&
      stored?.serverDrawing?.id === window.h.state.serverDrawing?.id
    );
  });
const draw = async (p = page, x = 550) => {
  await p.keyboard.press("Escape");
  await p.keyboard.press("r");
  await p.mouse.move(x, 350);
  await p.mouse.down();
  await p.mouse.move(x + 120, 460, { steps: 5 });
  await p.mouse.up();
  await p.keyboard.press("Escape");
};

(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "arabidraw-v2-test-"));
  const apiPort = await freePort();
  const uiPort = await freePort();
  const apiURL = `http://127.0.0.1:${apiPort}`;
  const uiURL = `http://127.0.0.1:${uiPort}`;
  const compile = start(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "-p",
    "server/tsconfig.json",
    "--outDir",
    path.join(temporary, "api"),
  ]);
  const [code] = await once(compile, "exit");
  assert.equal(code, 0, compile.output);
  const startAPI = () =>
    start(process.execPath, [path.join(temporary, "api/index.js")], {
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(apiPort),
        DRAWINGS_DIR: path.join(temporary, "drawings"),
      },
    });
  let api = startAPI();
  await waitForServer(`${apiURL}/api/drawings`, api);
  const ui = start(
    process.execPath,
    [
      path.join(root, "node_modules/vite/bin/vite.js"),
      "--host",
      "127.0.0.1",
      "--port",
      String(uiPort),
      "--strictPort",
    ],
    {
      cwd: path.join(root, "excalidraw-app"),
      env: {
        ...process.env,
        DRAWINGS_API_URL: apiURL,
        VITE_APP_ENABLE_ESLINT: "false",
        VITE_APP_ENABLE_TRACKING: "false",
      },
    },
  );
  await waitForServer(uiURL, ui);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE_PATH
      ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH }
      : {}),
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.addInitScript(() => {
    delete window.showOpenFilePicker;
    delete window.showSaveFilePicker;
    Object.defineProperty(window.crypto, "randomUUID", { value: undefined });
  });
  page = await context.newPage();
  page.setDefaultTimeout(20000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let acceptDialog = true;
  page.on("dialog", (d) => (acceptDialog ? d.accept() : d.dismiss()));
  await page.goto(uiURL);
  await page.getByRole("button", { name: "Save", exact: true }).waitFor();
  const list = async () => (await fetch(`${apiURL}/api/drawings`)).json();
  const get = async (id) =>
    (await fetch(`${apiURL}/api/drawings/${id}`)).json();
  let original;
  let copy;

  await test("create an Arabic-named drawing through the UI; blank names disabled", async () => {
    await draw();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await dialog().getByLabel("Drawing name", { exact: true }).fill("   ");
    assert.equal(
      await dialog()
        .getByRole("button", { name: "Save", exact: true })
        .isDisabled(),
      true,
    );
    await dialog().getByLabel("Drawing name", { exact: true }).fill("رسم عربي");
    await dialog().getByRole("button", { name: "Save", exact: true }).click();
    await dialog().getByText("Saved to server", { exact: true }).waitFor();
    original = await identity();
    assert.equal((await list()).length, 1);
    assert.equal((await get(original.id)).scene.elements.length, 1);
    await dialog()
      .getByRole("img", { name: "Preview of رسم عربي", exact: true })
      .waitFor();
    await closeGallery();
  });
  await test("reload preserves identity and clean state", async () => {
    await persisted();
    await page.reload();
    await openGallery();
    await dialog().getByText("Saved to server", { exact: true }).waitFor();
    assert.equal((await identity()).id, original.id);
    await closeGallery();
  });
  await test("toolbar and Ctrl+S update the same file; edits survive reload", async () => {
    await draw(page, 800);
    await page.keyboard.press("Control+s");
    await page.waitForFunction(
      (revision) => window.h.state.serverDrawing?.revision !== revision,
      original.revision,
    );
    original = await identity();
    assert.equal((await list()).length, 1);
    assert.equal((await get(original.id)).scene.elements.length, 2);
    await draw(page, 950);
    await page.waitForFunction(
      () => JSON.parse(localStorage.getItem("excalidraw"))?.length === 3,
    );
    await page.reload();
    await openGallery();
    await dialog().getByText("Unsaved changes", { exact: true }).waitFor();
    await closeGallery();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(
      (revision) => window.h.state.serverDrawing?.revision !== revision,
      original.revision,
    );
    original = await identity();
    assert.equal((await get(original.id)).scene.elements.length, 3);
  });
  await test("rename updates; Save as copy makes a new file; load remains clean", async () => {
    await openGallery();
    await dialog()
      .getByLabel("Drawing name", { exact: true })
      .fill("Renamed drawing");
    await dialog().getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(
      () => window.h.state.serverDrawing?.name === "Renamed drawing",
    );
    assert.equal((await identity()).id, original.id);
    original = await identity();
    await dialog()
      .getByLabel("Drawing name", { exact: true })
      .fill("Copy drawing");
    await dialog()
      .getByRole("button", { name: "Save as copy", exact: true })
      .click();
    await page.waitForFunction(
      () => window.h.state.serverDrawing?.name === "Copy drawing",
    );
    copy = await identity();
    assert.notEqual(copy.id, original.id);
    assert.equal((await list()).length, 2);
    await dialog()
      .getByRole("button", { name: "Load Renamed drawing", exact: true })
      .click();
    await dialog().waitFor({ state: "hidden" });
    await openGallery();
    await dialog().getByText("Saved to server", { exact: true }).waitFor();
    await closeGallery();
  });
  await test("dirty-load cancellation preserves canvas; acceptance restores saved scene", async () => {
    await draw(page, 1100);
    await openGallery();
    acceptDialog = false;
    await dialog()
      .getByRole("button", { name: "Load Copy drawing", exact: true })
      .click();
    assert.equal((await identity()).id, original.id);
    assert.equal(
      await page.evaluate(
        () => window.h.elements.filter((el) => !el.isDeleted).length,
      ),
      4,
    );
    acceptDialog = true;
    await dialog()
      .getByRole("button", { name: "Load Copy drawing", exact: true })
      .click();
    await dialog().waitFor({ state: "hidden" });
    assert.equal((await identity()).id, copy.id);
    assert.equal(
      await page.evaluate(
        () => window.h.elements.filter((el) => !el.isDeleted).length,
      ),
      3,
    );
  });
  await test("network failure preserves changes and retry succeeds", async () => {
    await draw();
    await page.route("**/api/drawings/*", (route) =>
      route.request().method() === "PUT" ? route.abort() : route.continue(),
    );
    await page.keyboard.press("Control+s");
    await dialog()
      .getByRole("alert")
      .filter({ hasText: "Cannot reach" })
      .waitFor();
    assert.equal((await get(copy.id)).scene.elements.length, 3);
    await page.unroute("**/api/drawings/*");
    await dialog().getByRole("button", { name: "Save", exact: true }).click();
    await dialog().getByText("Saved to server", { exact: true }).waitFor();
    copy = await identity();
    await closeGallery();
  });
  await test("another browser cannot silently overwrite or delete a newer revision", async () => {
    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    other.on("dialog", (d) => d.accept());
    await other.goto(uiURL);
    await openGallery(other);
    await dialog(other)
      .getByRole("button", { name: "Load Copy drawing", exact: true })
      .click();
    await dialog(other).waitFor({ state: "hidden" });
    await draw();
    await page.keyboard.press("Control+s");
    await page.waitForFunction(
      (revision) => window.h.state.serverDrawing?.revision !== revision,
      copy.revision,
    );
    await draw(other);
    await other.keyboard.press("Control+s");
    await dialog(other)
      .getByRole("alert")
      .filter({ hasText: "changed on the server" })
      .waitFor();
    const staleDelete = await fetch(`${apiURL}/api/drawings/${copy.id}`, {
      method: "DELETE",
      headers: { "If-Match": `"${copy.revision}"` },
    });
    assert.equal(staleDelete.status, 409);
    await dialog(other)
      .getByLabel("Drawing name", { exact: true })
      .fill("Recovered conflict");
    await dialog(other)
      .getByRole("button", { name: "Save as copy", exact: true })
      .click();
    await dialog(other).getByText("Saved to server", { exact: true }).waitFor();
    await otherContext.close();
    copy = await identity();
  });
  await test("clear canvas detaches server identity", async () => {
    await page.getByTestId("main-menu-trigger").click();
    await page.getByText("Reset the canvas", { exact: true }).click();
    await page
      .getByRole("dialog", { name: "Clear canvas", exact: true })
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await page.waitForFunction(() => window.h.state.serverDrawing === null);
    assert.equal((await get(copy.id)).scene.elements.length, 5);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await dialog().getByText("Not saved to server", { exact: true }).waitFor();
    await closeGallery();
  });
  await test("file import detaches identity; Arabic text, images and background round-trip", async () => {
    await openGallery();
    await dialog()
      .getByRole("button", { name: "Load Renamed drawing", exact: true })
      .click();
    await dialog().waitFor({ state: "hidden" });
    const scene = (await get(original.id)).scene;
    const rectangle = scene.elements[0];
    const png = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 16;
      c.height = 16;
      c.getContext("2d").fillRect(0, 0, 16, 16);
      return c.toDataURL();
    });
    const fixture = {
      ...scene,
      elements: [
        {
          ...rectangle,
          id: "arabic-text",
          type: "text",
          x: 50,
          y: 50,
          width: 200,
          height: 65,
          text: "مرحبا بالعالم\nاختبار الحفظ",
          originalText: "مرحبا بالعالم\nاختبار الحفظ",
          fontSize: 20,
          fontFamily: 12,
          lineHeight: 1.625,
          textAlign: "right",
          verticalAlign: "top",
          containerId: null,
          autoResize: true,
        },
        {
          ...rectangle,
          id: "embedded-image",
          type: "image",
          x: 350,
          y: 150,
          width: 160,
          height: 160,
          fileId: "qa-image",
          status: "saved",
          scale: [1, 1],
          crop: null,
        },
      ],
      appState: { ...scene.appState, viewBackgroundColor: "#ffec99" },
      files: {
        "qa-image": {
          id: "qa-image",
          mimeType: "image/png",
          dataURL: png,
          created: 1,
        },
      },
    };
    const chooser = page.waitForEvent("filechooser");
    await page.keyboard.press("Control+o");
    await (
      await chooser
    ).setFiles({
      name: "fixture.excalidraw",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(fixture)),
    });
    await page.waitForFunction(() =>
      window.h.elements.some((el) => el.id === "embedded-image"),
    );
    assert.equal(await identity(), null);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await dialog()
      .getByLabel("Drawing name", { exact: true })
      .fill("Image and Arabic");
    await dialog().getByRole("button", { name: "Save", exact: true }).click();
    await dialog().getByText("Saved to server", { exact: true }).waitFor();
    const imageDrawing = await identity();
    const saved = (await get(imageDrawing.id)).scene;
    assert.equal(saved.files["qa-image"].dataURL, png);
    assert.equal(saved.appState.viewBackgroundColor, "#ffec99");
    assert.equal(saved.appState.serverDrawing, undefined);
    await dialog()
      .getByRole("img", { name: "Preview of Image and Arabic", exact: true })
      .waitFor();
    await dialog()
      .getByRole("button", { name: "Load Renamed drawing", exact: true })
      .click();
    await dialog().waitFor({ state: "hidden" });
    await openGallery();
    await dialog()
      .getByRole("button", { name: "Load Image and Arabic", exact: true })
      .click();
    await dialog().waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => window.h.app.files["qa-image"].dataURL),
      png,
    );
    assert.equal(
      await page.evaluate(() => window.h.state.viewBackgroundColor),
      "#ffec99",
    );
    assert.equal(
      await page.evaluate(
        () => window.h.elements.find((el) => el.type === "text").text,
      ),
      "مرحبا بالعالم\nاختبار الحفظ",
    );
    await persisted();
    await page.reload();
    await openGallery();
    await dialog().getByText("Saved to server", { exact: true }).waitFor();
  });
  await test("cancel deletion preserves the file; deleting the active copy keeps the canvas", async () => {
    const active = await identity();
    const before = await page.evaluate(() => JSON.stringify(window.h.elements));
    acceptDialog = false;
    await dialog()
      .getByRole("button", { name: "Delete Image and Arabic", exact: true })
      .click();
    assert.equal((await get(active.id)).id, active.id);
    acceptDialog = true;
    await dialog()
      .getByRole("button", { name: "Delete Image and Arabic", exact: true })
      .click();
    await page.waitForFunction(() => window.h.state.serverDrawing === null);
    assert.equal(
      (await fetch(`${apiURL}/api/drawings/${active.id}`)).status,
      404,
    );
    assert.equal(
      await page.evaluate(() => JSON.stringify(window.h.elements)),
      before,
    );
    await dialog()
      .getByLabel("Drawing name", { exact: true })
      .fill("Resaved images");
    await dialog().getByRole("button", { name: "Save", exact: true }).click();
    await dialog().getByText("Saved to server", { exact: true }).waitFor();
    await closeGallery();
  });
  await test("slow save tracks later edits and prevents duplicate requests", async () => {
    const before = await identity();
    let resolveRequest;
    let intercepted;
    const requestSeen = new Promise((resolve) => {
      resolveRequest = resolve;
    });
    await page.route("**/api/drawings/*", async (route) => {
      if (route.request().method() === "PUT") {
        intercepted = route;
        resolveRequest();
      } else {
        await route.continue();
      }
    });
    await draw();
    await page.keyboard.press("Control+s");
    await requestSeen;
    await page.keyboard.press("Control+s");
    await draw(page, 800);
    await intercepted.continue();
    await page.unroute("**/api/drawings/*");
    await page.waitForFunction(
      (revision) => window.h.state.serverDrawing?.revision !== revision,
      before.revision,
    );
    await openGallery();
    await dialog().getByText("Unsaved changes", { exact: true }).waitFor();
    await dialog().getByRole("button", { name: "Save", exact: true }).click();
    await dialog().getByText("Saved to server", { exact: true }).waitFor();
    await closeGallery();
  });
  await test("retry after a lost create response does not duplicate the drawing", async () => {
    await openGallery();
    await dialog()
      .getByLabel("Drawing name", { exact: true })
      .fill("Lost response copy");
    const before = (await list()).length;
    await page.route("**/api/drawings", async (route) => {
      if (route.request().method() === "POST") {
        await route.fetch();
        await route.abort();
      } else {
        await route.continue();
      }
    });
    await dialog()
      .getByRole("button", { name: "Save as copy", exact: true })
      .click();
    await dialog()
      .getByRole("alert")
      .filter({ hasText: "Cannot reach" })
      .waitFor();
    assert.equal((await list()).length, before + 1);
    await page.unroute("**/api/drawings");
    await dialog()
      .getByRole("button", { name: "Save as copy", exact: true })
      .click();
    await dialog().getByText("Saved to server", { exact: true }).waitFor();
    assert.equal((await list()).length, before + 1);
    await closeGallery();
  });
  await test("mobile gallery fits the viewport and supports saving", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openGallery();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await dialog()
      .getByLabel("Drawing name", { exact: true })
      .fill("Mobile save");
    await dialog().getByRole("button", { name: "Save", exact: true }).click();
    await page.waitForFunction(
      () => window.h.state.serverDrawing?.name === "Mobile save",
    );
    await page.screenshot({ path: path.join(temporary, "mobile.png") });
    // Mobile dialogs also have an icon-only Close button.
    await dialog()
      .getByRole("button", { name: "Close", exact: true })
      .last()
      .click();
    await page.setViewportSize({ width: 1440, height: 1000 });
  });
  await test("two tabs keep separate canvases when switching focus and reloading", async () => {
    const before = await identity();
    const elements = await page.evaluate(() =>
      JSON.stringify(window.h.elements),
    );
    const other = await context.newPage();
    other.on("dialog", (d) => d.accept());
    await other.goto(uiURL);
    await openGallery(other);
    await dialog(other)
      .getByRole("button", { name: "Load Renamed drawing", exact: true })
      .click();
    await dialog(other).waitFor({ state: "hidden" });
    await persisted(other);
    await page.bringToFront();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForTimeout(1000); // Cross-tab synchronization is deliberately debounced.
    assert.equal((await identity()).id, before.id);
    assert.equal(
      await page.evaluate(() => JSON.stringify(window.h.elements)),
      elements,
    );
    await page.reload();
    await page.getByRole("button", { name: "Drawings", exact: true }).waitFor();
    assert.equal((await identity()).id, before.id);
    await other.close();
  });
  await test("menus retain normal share, export and help without paid/social/AI promotions", async () => {
    await page.getByTestId("main-menu-trigger").click();
    const menuText = await page.locator("body").innerText();
    assert.doesNotMatch(
      menuText,
      /Excalidraw\+|Sign up|Follow us|Discord|Generate with AI/,
    );
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Share", exact: true }).click();
    await page.getByText("Live collaboration", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await page.keyboard.press("?");
    await page.getByRole("dialog", { name: "Help", exact: true }).waitFor();
    const help = await page.locator("body").innerText();
    assert.doesNotMatch(help, /Documentation|Blog|YouTube/);
    await page.keyboard.press("Escape");
    await page
      .getByRole("dialog", { name: "Help", exact: true })
      .waitFor({ state: "hidden" });
    await openGallery();
    await page.screenshot({ path: path.join(temporary, "desktop.png") });
    await closeGallery();
  });
  await test("API validation, concurrent saves and persistence after restart", async () => {
    assert.equal(
      (await fetch(`${apiURL}/api/drawings/not-a-uuid`)).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${apiURL}/api/drawings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "broken",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(`${apiURL}/api/drawings`, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        })
      ).status,
      415,
    );
    const current = await get((await identity()).id);
    const update = (name, revision = current.revision) =>
      fetch(`${apiURL}/api/drawings/${current.id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "If-Match": `"${revision}"`,
        },
        body: JSON.stringify({ name, scene: current.scene }),
      });
    const responses = await Promise.all([
      update("Concurrent A"),
      update("Concurrent B"),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (
        await fetch(`${apiURL}/api/drawings/${current.id}`, {
          method: "DELETE",
        })
      ).status,
      428,
    );
    for (const name of ["", "x".repeat(201)]) {
      assert.equal(
        (
          await fetch(`${apiURL}/api/drawings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, scene: current.scene }),
          })
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await fetch(`${apiURL}/api/drawings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Oversized",
            padding: "x".repeat(50 * 1024 * 1024),
            scene: current.scene,
          }),
        })
      ).status,
      413,
    );
    const beforeRestart = await list();
    api.kill("SIGTERM");
    await once(api, "exit");
    api = startAPI();
    await waitForServer(`${apiURL}/api/drawings`, api);
    assert.deepEqual(await list(), beforeRestart);
    assert.equal(
      (await fs.readdir(path.join(temporary, "drawings"))).some((name) =>
        name.endsWith(".tmp"),
      ),
      false,
    );
  });
  console.log("Browser regression stages complete", { temporary, pageErrors });
  assert.deepEqual(pageErrors, []);
})()
  .catch(async (error) => {
    console.error(error);
    if (page && temporary) {
      await page
        .screenshot({
          path: path.join(temporary, "failure.png"),
          fullPage: true,
        })
        .catch(() => {});
      console.error(`Artifacts: ${temporary}`);
      console.error(
        (
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(-5000),
      );
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await browser?.close();
    for (const child of children) {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
    }
  });
