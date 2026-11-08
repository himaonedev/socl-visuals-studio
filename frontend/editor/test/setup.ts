import "@testing-library/jest-dom/vitest";
import { useUiStore } from "@/store/ui";

// Existing editing fixtures represent a project already open. Startup tests
// explicitly opt into the home screen before mounting App.
beforeEach(() => useUiStore.setState({ appView: "editor", hasSession: true }));

// jsdom does not implement media playback; stub the pieces the preview drives.
Object.defineProperty(HTMLMediaElement.prototype, "play", {
  configurable: true,
  value: vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: false });
    return Promise.resolve();
  }),
});
Object.defineProperty(HTMLMediaElement.prototype, "pause", {
  configurable: true,
  value: vi.fn(function (this: HTMLMediaElement) {
    Object.defineProperty(this, "paused", { configurable: true, value: true });
  }),
});

// Tauri's webview bridge does not exist under jsdom; individual tests may override this mock.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost${path}`,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({ onCloseRequested: vi.fn(async () => () => {}), destroy: vi.fn() })),
}));

beforeEach(() => { window.__soclEditorActive = true; });

