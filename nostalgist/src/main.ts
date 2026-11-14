import { Button, Gamepad } from "@rbuljan/gamepad";
import { primaryInput } from "detect-it";
import { Dexie, type EntityTable } from "dexie";
import fetchProgress from "fetch-progress";
import { toBase64 } from "js-base64";
import { Nostalgist } from "nostalgist";
import ProgressBar from "progressbar.js";
import { Spinner } from "spin.js";
import { installGame, type Manifest } from "./pak";

const CORE_NAME = "mkxp-z";

// True if RetroArch was built with OPFS support by passing
// `HAVE_THREADS=1 PROXY_TO_PTHREAD=1 HAVE_AUDIOWORKLET=1 HAVE_RWEBAUDIO=0 HAVE_AL=0 HAVE_WASMFS=1 HAVE_EXTRA_WASMFS=1`
// when building RetroArch and building the core with `-pthread`, otherwise false.
// It's highly recommended to build with OPFS support because it allows loading downloaded games/RTPs directly from the disk instead of loading the entire game/RTP into memory.
const HAVE_OPFS =
  typeof import.meta.env.VITE_HAVE_OPFS !== "string" ||
  import.meta.env.VITE_HAVE_OPFS !== "false";

const REQUIRE_OPFS =
  HAVE_OPFS &&
  (typeof import.meta.env.VITE_REQUIRE_OPFS !== "string" ||
    import.meta.env.VITE_REQUIRE_OPFS !== "false");

const CORE_JS_PATH = new URL(
  import.meta.env.VITE_CORE_JS_PATH,
  location.href,
).toString();
const CORE_WASM_PATH = new URL(
  import.meta.env.VITE_CORE_WASM_PATH,
  location.href,
).toString();
const GAME_PATH =
  typeof import.meta.env.VITE_GAME_PATH === "string"
    ? new URL(import.meta.env.VITE_GAME_PATH, location.href).toString()
    : null;
const RTP_PATH =
  typeof import.meta.env.VITE_RTP_PATH === "string"
    ? new URL(import.meta.env.VITE_RTP_PATH, location.href).toString()
    : null;

const CORE_JS_SIZE = parseInt(import.meta.env.VITE_CORE_JS_SIZE);
const CORE_WASM_SIZE = parseInt(import.meta.env.VITE_CORE_WASM_SIZE);
const GAME_SIZE = parseInt(import.meta.env.VITE_GAME_SIZE);
const RTP_SIZE = parseInt(import.meta.env.VITE_RTP_SIZE);

const CORE_JS_HASH =
  typeof import.meta.env.VITE_CORE_JS_HASH === "string"
    ? import.meta.env.VITE_CORE_JS_HASH
    : "";
const CORE_WASM_HASH =
  typeof import.meta.env.VITE_CORE_WASM_HASH === "string"
    ? import.meta.env.VITE_CORE_WASM_HASH
    : "";
const GAME_HASH =
  typeof import.meta.env.VITE_GAME_HASH === "string"
    ? import.meta.env.VITE_GAME_HASH
    : "";
const RTP_HASH =
  typeof import.meta.env.VITE_RTP_HASH === "string"
    ? import.meta.env.VITE_RTP_HASH
    : "";

const XP_CONTROLS =
  typeof import.meta.env.VITE_XP_CONTROLS !== "string" ||
  import.meta.env.VITE_XP_CONTROLS !== "false";

const GAME_NAME =
  typeof import.meta.env.VITE_GAME_NAME === "string"
    ? import.meta.env.VITE_GAME_NAME
    : null;

// This can be arbitrary but needs to have at least two path elements when using OPFS
const PERSISTENT_DIRECTORY = "/nostalgist/persistent";

// These can be arbitrary subdirectories of the persistent directory
const SAVE_DIRECTORY = PERSISTENT_DIRECTORY + "/saves/" + CORE_NAME;
const STATE_DIRECTORY = PERSISTENT_DIRECTORY + "/states/" + CORE_NAME;
const OPFS_SYSTEM_DIRECTORY = PERSISTENT_DIRECTORY + "/system/" + CORE_NAME;

const GAME_OPFS_PATH =
  GAME_PATH === null ? null : toBase64(GAME_PATH, true) + ".mkxpz";
const RTP_OPFS_PATH =
  RTP_PATH === null
    ? null
    : OPFS_SYSTEM_DIRECTORY.slice(PERSISTENT_DIRECTORY.length) +
      "/mkxp-z/RTP/" +
      RTP_PATH.split("/").slice(-1)[0];

if (GAME_NAME !== null) {
  document.title = GAME_NAME;
}

const spinner = new Spinner({
  color: "#fff",
});
const spinnerTarget = document.getElementById("spinner-target");
if (spinnerTarget !== null) {
  spinner.spin(spinnerTarget);
}

const progressbarTarget = document.getElementById("progressbar-target");
const bar = new ProgressBar.Circle(progressbarTarget, {
  color: "#fff",
  strokeWidth: 6.0,
  step: (_, bar) => {
    const text = Math.round(bar.value() * 100) + "%";
    // @ts-expect-error The type of `bar` is set incorrectly by @types/progressbar.js
    bar.setText(text);
  },
});
bar.text!.style.fontSize = "20px";

let currentBytes = 0;
let totalBytes = 0;

const updateBar = () => {
  bar.set(
    isNaN(totalBytes) || !isFinite(totalBytes) || totalBytes === 0
      ? 0
      : currentBytes / totalBytes,
  );
};

// Disable bfcache because it may undo the loading of the game (e.g. when the user refreshes the page in Chromium after the game successfully loads)
window.addEventListener("pageshow", (ev) => {
  if (ev.persisted) {
    location.reload();
  }
});

// Multithreaded WebAssembly requires a secure context
if (!window.isSecureContext) {
  alert("This site only works if served over HTTPS.");
  throw "Not a secure context";
}

// Wait for coi-serviceworker.js to load
if (!window.crossOriginIsolated) {
  if (!("serviceWorker" in navigator)) {
    alert(
      "Your browser does not support service workers in private browsing mode. Either exit private browsing mode or try private browsing mode in a different browser.",
    );
    throw "Service workers are not available";
  }
  if (navigator.serviceWorker.controller === null) {
    throw "coi-serviceworker.js is not ready yet";
  }
}
const sessionStorageKey =
  "nostalgist status for " + CORE_NAME + " @ " + location.href;
if (window.sessionStorage.getItem(sessionStorageKey) !== "ready") {
  window.sessionStorage.setItem(sessionStorageKey, "ready");
  location.reload();
  throw "Reloading once to make coi-serviceworker.js less flaky";
}
if (!window.crossOriginIsolated) {
  console.error(
    "Cross-origin isolation is not enabled; reloading to enable it",
  );
  location.reload();
  throw "Reloading to enable cross-origin isolation";
}

const opfs = !HAVE_OPFS
  ? null
  : await (async () => {
      try {
        return await navigator.storage.getDirectory();
      } catch (err) {
        if (REQUIRE_OPFS) {
          alert(
            "Your browser does not support OPFS in private browsing mode. Either exit private browsing mode or try private browsing mode in a different browser.",
          );
          throw err;
        } else {
          // Fall back to not using OPFS
          console.error(err);
          return null;
        }
      }
    })();

const fetchWithCache = async (
  size: number,
  hash: string,
  path: string,
  opfsPath?: string,
) => {
  totalBytes += size;
  updateBar();

  let blob: Blob | undefined = undefined;
  let blobSource: "fetch" | "indexeddb" | "opfs" = "fetch";

  const db = new Dexie("nostalgist cache for " + CORE_NAME) as Dexie & {
    cache: EntityTable<
      {
        path: string;
        blob: Blob | null;
        hash: string;
      },
      "path"
    >;
  };
  db.version(2).stores({
    cache: "path",
  });

  try {
    // Try restoring the blob from IndexedDB and OPFS
    try {
      const result = await db.cache.get(path);
      if (result !== undefined && result.hash === hash) {
        if (result.blob !== null) {
          blobSource = "indexeddb";
          blob = result.blob;
        } else if (opfs !== null && opfsPath !== undefined) {
          let directory = opfs;
          const elements = opfsPath
            .split("/")
            .filter((element) => element.length !== 0);
          if (elements.length > 0) {
            for (const element of elements.slice(0, -1)) {
              directory = await directory.getDirectoryHandle(element, {
                create: true,
              });
            }
            const fileHandle = await directory.getFileHandle(
              elements.slice(-1)[0],
            );
            const fileBlob = await fileHandle.getFile();
            if (fileBlob.size === size) {
              blobSource = "opfs";
              blob = fileBlob;
            }
          }
        }
      }
    } catch (err) {
      console.error(err);
    }

    // If the blob is not cached, fetch it instead
    if (blob === undefined) {
      // Frost & Thaw: phones drop connections (and the page reloads once for
      // cross-origin isolation), so retry a failed download a few times
      for (let attempt = 0; ; attempt++) {
        let fetchedBytes = 0;
        try {
          const response = await fetch(path).then(
            fetchProgress({
              onProgress: (progress) => {
                currentBytes += progress.transferred - fetchedBytes;
                fetchedBytes = progress.transferred;
                updateBar();
                if (progressbarTarget !== null) {
                  spinner.stop();
                  progressbarTarget.style.display = "initial";
                }
              },
            }),
          );
          if (!response.ok) throw new Error("HTTP " + response.status);
          blob = await response.blob();
          break;
        } catch (err) {
          currentBytes -= fetchedBytes;
          if (attempt >= 5) throw err;
          await new Promise((r) =>
            setTimeout(r, 1000 * Math.min(30, 2 ** attempt)),
          );
        }
      }
    } else {
      currentBytes += size;
      updateBar();
    }
    if (blob === undefined) throw new Error("Couldn't download " + path);

    // Store the blob into IndexedDB and OPFS if needed
    if (
      blobSource !==
      (opfs !== null && opfsPath !== undefined ? "opfs" : "indexeddb")
    ) {
      try {
        await db.cache.put({
          path,
          blob: opfs !== null && opfsPath !== undefined ? null : blob,
          hash,
        });
      } catch (err) {
        console.error(err);
      }

      if (opfs !== null && opfsPath !== undefined) {
        try {
          let directory = opfs;
          const elements = opfsPath
            .split("/")
            .filter((element) => element.length !== 0);
          if (elements.length > 0) {
            for (const element of elements.slice(0, -1)) {
              directory = await directory.getDirectoryHandle(element, {
                create: true,
              });
            }
            const fileHandle = await directory.getFileHandle(
              elements.slice(-1)[0],
              { create: true },
            );
            const fileStream = await fileHandle.createWritable();
            await fileStream.write(blob);
            await fileStream.close();
            blob = await fileHandle.getFile();
          }
        } catch (err) {
          console.error(err);
        }
      }
    }

    return blob;
  } finally {
    db.close();
  }
};

// Frost & Thaw: boot watchdog. RetroArch sometimes stalls for good right after
// mounting OPFS (a start-up race in the threaded web build; a healthy start
// gets past it in well under a second). If it hasn't moved on after a while,
// reload the page, which starts it again. A few tries, then say so.
const WATCHDOG_KEY = "frost-thaw boot retries";
const WATCHDOG_MS = 20000;
let engineMounted = false;
let enginePastMount = false;
function noteEngineLine(line: string) {
  if (!engineMounted) {
    if (line.includes("Mount OPFS")) {
      engineMounted = true;
      setTimeout(() => {
        if (enginePastMount) return;
        const tries = parseInt(sessionStorage.getItem(WATCHDOG_KEY) ?? "0");
        if (tries < 4) {
          sessionStorage.setItem(WATCHDOG_KEY, String(tries + 1));
          console.warn("Engine start stalled; reloading (try " + (tries + 1) + ")");
          location.reload();
        } else {
          sessionStorage.removeItem(WATCHDOG_KEY);
          const status = document.getElementById("install-status");
          if (status !== null) {
            status.textContent =
              "The game didn't start. Close this tab and open the page again.";
          }
        }
      }, WATCHDOG_MS);
    }
  } else if (
    !enginePastMount &&
    (line.includes("=== Build") || line.includes("[libretro"))
  ) {
    enginePastMount = true;
    sessionStorage.removeItem(WATCHDOG_KEY);
  }
}

// Frost & Thaw: install (or update) the game into OPFS from its pack manifest
const GAME_MANIFEST =
  typeof import.meta.env.VITE_GAME_MANIFEST === "string"
    ? new URL(import.meta.env.VITE_GAME_MANIFEST, location.href).toString()
    : null;
let gameManifest: Manifest | null = null;
if (GAME_MANIFEST !== null) {
  if (opfs === null) {
    alert(
      "This browser can't store the game. Use Safari (iPhone/iPad) or Chrome (Android/computer), not a private window.",
    );
    throw "OPFS is required for the pack installer";
  }
  const status = document.getElementById("install-status");
  let counted = 0;
  try {
    gameManifest = await installGame(GAME_MANIFEST, "game", (done, total) => {
      if (counted === 0 && total > 0) {
        totalBytes += total;
        counted = total;
      }
      currentBytes = done;
      updateBar();
      if (total > 0 && progressbarTarget !== null) {
        spinner.stop();
        progressbarTarget.style.display = "initial";
      }
      if (status !== null && total > 0) {
        status.textContent =
          "Downloading the game: " +
          (done / 1e6).toFixed(0) +
          " of " +
          (total / 1e6).toFixed(0) +
          " MB. This only happens once; keep this page open.";
      }
    });
  } catch (err) {
    alert(String(err));
    throw err;
  }
  if (status !== null) status.textContent = "";
  currentBytes = 0;
  totalBytes = 0;
}

const [coreJsBlob, coreWasmBlob, gameBlob, rtpBlob] = await Promise.all([
  fetchWithCache(CORE_JS_SIZE, CORE_JS_HASH, CORE_JS_PATH),
  fetchWithCache(CORE_WASM_SIZE, CORE_WASM_HASH, CORE_WASM_PATH),
  GAME_PATH === null
    ? null
    : fetchWithCache(
        GAME_SIZE,
        GAME_HASH,
        GAME_PATH,
        GAME_OPFS_PATH ?? undefined,
      ),
  RTP_PATH === null
    ? null
    : fetchWithCache(RTP_SIZE, RTP_HASH, RTP_PATH, RTP_OPFS_PATH ?? undefined),
]);

const nostalgist = await Nostalgist.prepare({
  core: {
    name: CORE_NAME,
    js: coreJsBlob,
    wasm: coreWasmBlob,
  },
  rom:
    opfs !== null || GAME_PATH === null || gameBlob === null
      ? undefined
      : {
          fileName: toBase64(GAME_PATH, true) + ".mkxpz",
          fileContent: gameBlob,
        },
  bios:
    opfs !== null || rtpBlob === null
      ? undefined
      : {
          fileName: "RTP.mkxpz",
          fileContent: rtpBlob,
        },
  emscriptenModule: {
    // Frost & Thaw: watch the engine's start-up log for the boot watchdog below
    print: (...args: unknown[]) => {
      noteEngineLine(args.join(" "));
      console.info(...args);
    },
    printErr: (...args: unknown[]) => {
      noteEngineLine(args.join(" "));
      console.error(...args);
    },
    preRun: [
      (module) => {
        if (opfs !== null) {
          // Indicate to RetroArch that we want to enable OPFS support if it's supported
          module.ENV.OPFS_MOUNT = PERSISTENT_DIRECTORY;
        }
      },
    ],
  },
  element: "#nostalgist-canvas",
  retroarchConfig: {
    savefile_directory: SAVE_DIRECTORY,
    savestate_directory: STATE_DIRECTORY,
    system_directory:
      opfs !== null
        ? OPFS_SYSTEM_DIRECTORY
        : "/home/web_user/retroarch/userdata/system",
    log_verbosity: true,
    libretro_log_level: import.meta.env.DEV ? 0 : 1,
    frontend_log_level: import.meta.env.DEV ? 0 : 1,
    input_toggle_fast_forward: "space",
    input_hold_fast_forward: "l",
    input_toggle_slowmotion: "g",
    input_hold_slowmotion: "e",
    input_menu_toggle: "f1",
    input_save_state: "f2",
    input_load_state: "f4",
    input_state_slot_decrease: "f6",
    input_state_slot_increase: "f7",
    input_screenshot: "f8",
    input_player1_a: XP_CONTROLS ? "c" : "z",
    input_player1_b: "x",
    input_player1_x: XP_CONTROLS ? "z" : "shift",
    input_player1_y: "a",
    input_player1_l3: "s",
    input_player1_r3: "d",
    input_player1_l: "q",
    input_player1_r: "w",
    input_player1_l2: "ctrl",
    input_player1_r2: "rshift",
    input_player1_start: "alt",
  },
  retroarchCoreConfig: {
    "mkxp-z_saveStateSize": "256",
  },
});

if (opfs !== null) {
  // Create the save, state and system directories
  for (const directoryPath of [
    SAVE_DIRECTORY,
    STATE_DIRECTORY,
    OPFS_SYSTEM_DIRECTORY,
  ]) {
    let directory = opfs;
    for (const element of directoryPath
      .slice(PERSISTENT_DIRECTORY.length)
      .split("/")
      .filter((element) => element.length !== 0)) {
      directory = await directory.getDirectoryHandle(element, {
        create: true,
      });
    }
  }

  // Tell RetroArch to load the game from OPFS
  if (gameManifest !== null) {
    const module = nostalgist.getEmscripten().Module;
    const args: string[] = module.arguments ?? [];
    args.push(PERSISTENT_DIRECTORY + "/game/" + gameManifest.launch);
    module.arguments = args;
  } else if (GAME_PATH !== null) {
    const module = nostalgist.getEmscripten().Module;
    const args: string[] = module.arguments ?? [];
    args.push(PERSISTENT_DIRECTORY + "/" + GAME_OPFS_PATH);
    module.arguments = args;
  }
} else {
  const fs: typeof FS & {
    filesystems?: {
      MEMFS: Emscripten.FileSystemType;
      IDBFS?: Emscripten.FileSystemType;
    };
  } = nostalgist.getEmscriptenFS();

  // Move the RTP to the correct path
  if (RTP_PATH !== null) {
    const system_directory = "/home/web_user/retroarch/userdata/system";
    const system_directory_subdirectory = system_directory + "/mkxp-z/RTP";
    fs.mkdirTree(system_directory_subdirectory);
    fs.rename(
      system_directory + "/RTP.mkxpz",
      system_directory_subdirectory + "/" + RTP_PATH.split("/").slice(-1)[0],
    );
  }

  // If RetroArch was not built with OPFS support but was built with IDBFS support,
  // persist saves and save states to IndexedDB so that the user doesn't lose all of their saves and save states whenever the page is reloaded or closed
  if (fs.filesystems?.IDBFS !== undefined) {
    fs.mkdirTree(SAVE_DIRECTORY);
    fs.mkdirTree(STATE_DIRECTORY);
    fs.mount(fs.filesystems.IDBFS, { autoPersist: true }, SAVE_DIRECTORY);
    fs.mount(fs.filesystems.IDBFS, { autoPersist: true }, STATE_DIRECTORY);
    await new Promise<void>((resolve, reject) => {
      fs.syncfs(true, (err: Error | null) => {
        if (err === null) {
          resolve();
        } else {
          reject(err);
        }
      });
    });
  }
}

bar.destroy();
spinner.stop();

// Force the user to interact with the browser once before starting the game;
// otherwise the audio will not work because audio is gated behind sticky activation
// (see https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/User_activation)
while (!navigator.userActivation.hasBeenActive) {
  const prompt = document.getElementById("user-activation-prompt");
  if (prompt !== null) {
    prompt.style.display = "initial";
  }
  await new Promise<void>((resolve) => {
    const events = [
      "keydown",
      "mousedown",
      "pointerdown",
      "pointerup",
      "touchend",
    ];
    const listener = () => {
      for (const ev of events) {
        document.body.removeEventListener(ev, listener);
      }
      resolve();
    };
    for (const ev of events) {
      document.body.addEventListener(ev, listener);
    }
  });
  if (prompt !== null) {
    prompt.style.display = "none";
  }
}

// Show an on-screen gamepad overlay if the user is using a touchscreen device
const gamepadTarget = document.getElementById("gamepad-target");
if (primaryInput === "touch" && gamepadTarget !== null) {
  new Gamepad([
    new Button({
      id: "gamepad-x",
      text: "X",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "75px",
        right: "125px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "y" },
        );
      },
    }),
    new Button({
      id: "gamepad-y",
      text: "Y",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "75px",
        right: "75px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "l3" },
        );
      },
    }),
    new Button({
      id: "gamepad-z",
      text: "Z",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "75px",
        right: "25px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "r3" },
        );
      },
    }),
    new Button({
      id: "gamepad-a",
      text: "A",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "25px",
        right: "125px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "x" },
        );
      },
    }),
    new Button({
      id: "gamepad-b",
      text: "B",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "25px",
        right: "75px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "b" },
        );
      },
    }),
    new Button({
      id: "gamepad-c",
      text: "C",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "25px",
        right: "25px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "a" },
        );
      },
    }),
    new Button({
      id: "gamepad-down",
      text: "▼",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "25px",
        left: "62.5px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "down" },
        );
      },
    }),
    new Button({
      id: "gamepad-left",
      text: "◀",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "62.5px",
        left: "25px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "left" },
        );
      },
    }),
    new Button({
      id: "gamepad-right",
      text: "▶",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "62.5px",
        left: "100px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "right" },
        );
      },
    }),
    new Button({
      id: "gamepad-up",
      text: "▲",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        bottom: "100px",
        left: "62.5px",
      },
      onInput: (state) => {
        (state.isActive ? nostalgist.pressDown : nostalgist.pressUp).call(
          nostalgist,
          { button: "up" },
        );
      },
    }),
    new Button({
      id: "gamepad-save-state",
      text: "\u00a0SAVE\u00a0STATE\u00a0",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        top: "25px",
        left: "63px",
      },
      onInput: (state) => {
        // `nostalgist.sendCommand("SAVE_STATE")` doesn't always work for some reason
        nostalgist.getCanvas().dispatchEvent(
          new KeyboardEvent(state.isActive ? "keydown" : "keyup", {
            code: "F2",
          }),
        );
      },
    }),
    new Button({
      id: "gamepad-load-state",
      text: "\u00a0LOAD\u00a0STATE\u00a0",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        top: "75px",
        left: "63px",
      },
      onInput: (state) => {
        if (state.isActive) {
          nostalgist.sendCommand("LOAD_STATE");
        }
      },
    }),
    new Button({
      id: "gamepad-fast-forward",
      text: "\u00a0FAST\u00a0FORWARD\u00a0",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        top: "25px",
        right: "80px",
      },
      onInput: (state) => {
        if (state.isActive) {
          nostalgist.sendCommand("FAST_FORWARD");
        }
      },
    }),
    new Button({
      id: "gamepad-slow-motion",
      text: "\u00a0SLOW\u00a0MOTION\u00a0",
      parentElement: gamepadTarget,
      radius: 20,
      position: {
        top: "75px",
        right: "77px",
      },
      onInput: (state) => {
        if (state.isActive) {
          nostalgist.sendCommand("SLOWMOTION");
        }
      },
    }),
  ]);
}

await nostalgist.start();
