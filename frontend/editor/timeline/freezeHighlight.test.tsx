import { fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { FreezeHighlightPanel } from "@/components/inspector/FreezeHighlightPanel";
import { useProjectStore } from "@/store/project";
import { usePlaybackStore } from "@/store/playback";
import { expectValid, makeProject, IDS } from "@/test/makeProject";
import { addClip } from "./edit";
import { clipEnd, projectDuration } from "./clips";
import {
  applyFreezeHighlight,
  createFreezeHighlight,
  DEFAULT_FREEZE_HIGHLIGHT as settings,
  freezeWindow,
  type PreparedFreeze,
} from "./freezeHighlight";

const prepared: PreparedFreeze = {
  image: { path: "/cache/hold.png", mediaType: "image", width: 1920, height: 1080 },
  audio: null,
  hasAudio: true,
};
function project() {
  const r = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "video", duration: 8 });
  if (!r.ok) throw new Error(r.error.message);
  const after = addClip(r.project, {
    assetId: IDS.vid2,
    trackId: IDS.v1,
    start: 9,
    id: "later",
    duration: 3,
  });
  if (!after.ok) throw new Error(after.error.message);
  return after.project;
}
beforeEach(() => {
  useProjectStore.getState().loadProject(project(), "/test.cutvii", []);
  usePlaybackStore.setState({ playhead: 2, playing: false });
  vi.mocked(invoke).mockReset();
});

it('keeps timed caption layers running when only the video is frozen', () => {
  const withCaption = addClip(project(), { assetId: IDS.img, trackId: IDS.v2, start: 2, id: 'caption-layer', duration: 4 });
  if (!withCaption.ok) throw new Error(withCaption.error.message);
  const captions = withCaption.project.tracks.find(track => track.id === IDS.v2)!.clips;
  const result = applyFreezeHighlight(withCaption.project, 'video', 2, settings, prepared);
  if (!result.ok) throw new Error(result.error.message);
  expectValid(result.project);
  expect(result.project.tracks.find(track => track.id === IDS.v2)!.clips).toEqual(captions);
  expect(projectDuration(result.project)).toBe(projectDuration(withCaption.project));
});

it("holds the picture without moving later clips, and preserves the complete voice exactly once", () => {
  const p = project(),
    r = applyFreezeHighlight(p, "video", 2, settings, prepared);
  if (!r.ok) throw new Error(r.error.message);
  expectValid(r.project);
  expect(projectDuration(r.project)).toBe(projectDuration(p));
  const video = r.project.tracks[0].clips;
  expect(video.find((c) => c.id === "later")!.timelineStart).toBe(9);
  expect(video.filter((c) => c.id !== "later").every((c) => c.muted)).toBe(true);
  const audio = r.project.tracks.at(-1)!;
  expect(audio.type).toBe("audio");
  expect(audio.clips).toHaveLength(1);
  expect(audio.clips[0]).toMatchObject({ sourceIn: 0, sourceOut: 8, timelineStart: 0, assetId: IDS.vid });
  expect(p.tracks[0].clips).toHaveLength(2);
});
it("replaces only the emphasized speech range with processed audio, preserving the outside and gain", () => {
  const p = project();
  p.tracks[0].clips[0] = {
    ...p.tracks[0].clips[0],
    volume: 0.6,
    fadeIn: 0.5,
    fadeOut: 0.5,
    clean: { noise: 0.3, rumble: true },
  };
  const r = applyFreezeHighlight(
    p,
    "video",
    2,
    { ...settings, audio: "echo" },
    { ...prepared, audio: { path: "/cache/voice.wav", mediaType: "audio", duration: 1.5 } },
  );
  if (!r.ok) throw new Error(r.error.message);
  expectValid(r.project);
  const sound = r.project.tracks.at(-1)!.clips;
  expect(sound.map((c) => [c.timelineStart, clipEnd(c)])).toEqual([
    [0, 2],
    [2, 3.5],
    [3.5, 8],
  ]);
  expect(sound.every((c) => c.volume === 0.6)).toBe(true);
  expect(sound[0].fadeIn).toBe(0.5);
  expect(sound[2].fadeOut).toBe(0.5);
  expect(sound[1].clean).toBeUndefined();
  expect(() => freezeWindow(p, "video", 0.1, { ...settings, audio: "echo" })).toThrow(/fades/);
});
it("maps speed and reverse source ranges, and can start at the first frame", () => {
  const p = project();
  p.tracks[0].clips[0] = { ...p.tracks[0].clips[0], speed: 2, reversed: true };
  const r = applyFreezeHighlight(p, "video", 0, { ...settings, duration: 1 }, prepared);
  if (!r.ok) throw new Error(r.error.message);
  expectValid(r.project);
  const video = r.project.tracks[0].clips;
  expect(video[0]).toMatchObject({ sourceIn: 0, sourceOut: 1, timelineStart: 0 });
  expect(video[1]).toMatchObject({ sourceIn: 0, sourceOut: 6, timelineStart: 1, speed: 2, reversed: true });
  expect(() => freezeWindow(p, "video", 3.95, settings)).toThrow(/0.2/);
});
it("applies prepared media as one undo and refuses edits based on a stale project", async () => {
  vi.mocked(invoke).mockResolvedValue(prepared);
  const before = useProjectStore.getState().project;
  expect((await createFreezeHighlight("video", 2, settings)).ok).toBe(true);
  expectValid(useProjectStore.getState().project);
  useProjectStore.getState().undo();
  expect(useProjectStore.getState().project).toEqual(before);
  vi.mocked(invoke).mockImplementation(async () => {
    useProjectStore.setState({ project: { ...before, name: "Changed" } });
    return prepared;
  });
  await expect(createFreezeHighlight("video", 2, settings)).rejects.toThrow(/project changed/);
  expect(useProjectStore.getState().project.name).toBe("Changed");
});
it("offers custom texture, colour, duration, zoom and audio controls and sends them to preparation", async () => {
  vi.mocked(invoke).mockResolvedValue(prepared);
  render(<FreezeHighlightPanel clip={useProjectStore.getState().project.tracks[0].clips[0]} />);
  fireEvent.change(screen.getByLabelText("Paper colour"), { target: { value: "#ffaa00" } });
  expect(screen.queryByLabelText("Pattern bend")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Dot pattern"), { target: { value: "wave" } });
  fireEvent.change(screen.getByLabelText("Pattern bend"), { target: { value: "0.75" } });
  fireEvent.change(screen.getByLabelText("Dot size"), { target: { value: "10" } });
  fireEvent.change(screen.getByLabelText("Zoom"), { target: { value: "1.2" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply Freeze Highlight" }));
  await screen.findByText(/applied/);
  expect(invoke).toHaveBeenCalledWith("prepare_freeze_highlight", {
    request: expect.objectContaining({
      time: 2,
      sourceIn: 2,
      sourceOut: 3.5,
      seconds: 1.5,
      settings: expect.objectContaining({
        color: "#FFAA00",
        spacing: 10,
        pattern: "wave",
        bend: 0.75,
        audio: "none",
      }),
    }),
  });
});

it.each(["mono", "paper"] as const)("offers %s without subject segmentation", async (style) => {
  vi.mocked(invoke).mockResolvedValue(prepared);
  render(<FreezeHighlightPanel clip={useProjectStore.getState().project.tracks[0].clips[0]} />);
  fireEvent.change(screen.getByLabelText("Visual style"), { target: { value: style } });
  expect(screen.getByLabelText("Freeze duration (seconds)")).toBeVisible();
  expect(screen.queryByLabelText("Dot pattern")).not.toBeInTheDocument();
  if (style === "paper")
    fireEvent.change(screen.getByLabelText("Paper tint"), { target: { value: "#f0d0b0" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply Freeze Highlight" }));
  await screen.findByText(/applied/);
  expect(invoke).toHaveBeenCalledWith("prepare_freeze_highlight", {
    request: expect.objectContaining({ settings: expect.objectContaining({ style, opacity: 1 }) }),
  });
});
it("checks the local cut-out runtime and sends custom outline and character zoom settings", async () => {
  let ready = false;
  vi.mocked(invoke).mockImplementation(async (cmd) =>
    cmd === "highlight_runtime" ? { ready, reason: ready ? null : "Python unavailable" } : prepared,
  );
  render(<FreezeHighlightPanel clip={useProjectStore.getState().project.tracks[0].clips[0]} />);
  fireEvent.change(screen.getByLabelText("Visual style"), { target: { value: "outline" } });
  expect(screen.getByRole("button", { name: "Apply Freeze Highlight" })).toBeDisabled();
  await screen.findByText("Python unavailable");
  ready = true;
  fireEvent.click(screen.getByRole("button", { name: "Check local runtime" }));
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Apply Freeze Highlight" })).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText("Outline colour"), { target: { value: "#ff8800" } });
  fireEvent.change(screen.getByLabelText("Outline width"), { target: { value: "24" } });
  fireEvent.change(screen.getByLabelText("Character zoom"), { target: { value: "1.25" } });
  fireEvent.click(screen.getByRole("button", { name: "Apply Freeze Highlight" }));
  await screen.findByText(/applied/);
  expect(invoke).toHaveBeenCalledWith("prepare_freeze_highlight", {
    request: expect.objectContaining({
      settings: expect.objectContaining({
        style: "outline",
        outlineColor: "#FF8800",
        outlineWidth: 24,
        subjectZoom: 1.25,
      }),
    }),
  });
});

it("applies a silent moving video at normal timeline speed while preserving source motion and audio", () => {
  const p = project();
  p.tracks[0].clips[0] = {
    ...p.tracks[0].clips[0],
    speed: 2,
    keyframes: {
      x: [
        { t: 0, v: 0 },
        { t: 8, v: 0.8 },
      ],
    },
  };
  const moving = { ...settings, playback: "moving" as const, zoom: 1 };
  const media = {
    ...prepared,
    image: {
      path: "/cache/moving.mp4",
      mediaType: "video" as const,
      width: 1920,
      height: 1080,
      duration: 1.5,
    },
  };
  const r = applyFreezeHighlight(p, "video", 1, moving, media);
  if (!r.ok) throw new Error(r.error.message);
  expectValid(r.project);
  const videoAsset = r.project.assets.find((a) => a.path === media.image.path)!;
  const applied = r.project.tracks[0].clips.find((c) => c.assetId === videoAsset.id)!;
  expect(videoAsset.type).toBe("video");
  expect(applied).toMatchObject({ timelineStart: 1, sourceIn: 0, sourceOut: 1.5, muted: true });
  expect(applied.speed).toBeUndefined();
  expect(applied.reversed).toBeUndefined();
  expect(applied.keyframes!.x).toEqual([
    { t: 0, v: 0.2 },
    { t: 1.5, v: 0.5 },
  ]);
  expect(r.project.tracks.at(-1)!.clips[0]).toMatchObject({
    assetId: IDS.vid,
    speed: 2,
    sourceIn: 0,
    sourceOut: 8,
  });
  expect(projectDuration(r.project)).toBe(projectDuration(p));
});
it("whole-clip moving effects ignore playhead position and reject reverse or overlong ranges", () => {
  const p = project();
  const whole = { ...settings, playback: "moving" as const, wholeClip: true };
  expect(freezeWindow(p, "video", 20, whole)).toMatchObject({ start: 0, stop: 8 });
  p.tracks[0].clips[0].reversed = true;
  expect(() => freezeWindow(p, "video", 2, whole)).toThrow(/Forward/);
  p.tracks[0].clips[0].reversed = false;
  p.tracks[0].clips[0].sourceOut = 200;
  expect(() => freezeWindow(p, "video", 2, whole)).toThrow(/120 seconds/);
});
it("offers moving playback, whole-clip scope and sends the project frame rate to rendering", async () => {
  const media = {
    ...prepared,
    image: { path: "/cache/moving.mp4", mediaType: "video" as const, width: 1920, height: 1080, duration: 8 },
  };
  vi.mocked(invoke).mockImplementation(async (cmd) =>
    cmd === "highlight_runtime" ? { ready: true, reason: null } : media,
  );
  render(<FreezeHighlightPanel clip={useProjectStore.getState().project.tracks[0].clips[0]} />);
  fireEvent.change(screen.getByLabelText("Playback mode"), { target: { value: "moving" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Apply to whole selected clip" }));
  expect(screen.getByLabelText("Effect duration (seconds)")).toHaveValue(8);
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "Apply Moving Style" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Apply Moving Style" }));
  await screen.findByText(/Moving style applied/);
  expect(invoke).toHaveBeenCalledWith("prepare_freeze_highlight", {
    request: expect.objectContaining({
      sourceIn: 0,
      sourceOut: 8,
      seconds: 8,
      fps: 30,
      settings: expect.objectContaining({ playback: "moving" }),
    }),
  });
});

it("cancels a moving render without applying a partial edit", async () => {
  const before = useProjectStore.getState().project;
  let rejectRender: (reason: unknown) => void = () => {};
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === "highlight_runtime") return { ready: true, reason: null };
    if (cmd === "prepare_freeze_highlight")
      return new Promise((_, reject) => {
        rejectRender = reject;
      });
    if (cmd === "cancel_ai_job") {
      rejectRender("export cancelled");
      return undefined;
    }
    return undefined;
  });
  render(<FreezeHighlightPanel clip={before.tracks[0].clips[0]} />);
  fireEvent.change(screen.getByLabelText("Playback mode"), { target: { value: "moving" } });
  await vi.waitFor(() => expect(screen.getByRole("button", { name: "Apply Moving Style" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Apply Moving Style" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel moving render" }));
  await screen.findByText("Moving render cancelled. No edit applied.");
  expect(useProjectStore.getState().project).toBe(before);
});

it("requires an image only for subject image backgrounds and sends the chosen file in both playback modes", async () => {
  for (const playback of ["freeze", "moving"] as const) {
    const custom = { ...settings, style: "outline" as const, playback, backgroundMode: "image" as const };
    expect(() => freezeWindow(project(), "video", 2, custom)).toThrow("Choose a background image");
    vi.mocked(invoke).mockResolvedValue({
      ...prepared,
      image:
        playback === "moving"
          ? { path: "/cache/moving.mp4", mediaType: "video", duration: 2, width: 1920, height: 1080 }
          : prepared.image,
    });
    useProjectStore.getState().loadProject(project(), "/test.cutvii", []);
    await createFreezeHighlight("video", 2, { ...custom, backgroundImage: "/media/backdrop.png" });
    expect(invoke).toHaveBeenLastCalledWith(
      "prepare_freeze_highlight",
      expect.objectContaining({
        request: expect.objectContaining({
          settings: expect.objectContaining({
            playback,
            backgroundMode: "image",
            backgroundImage: "/media/backdrop.png",
          }),
        }),
      }),
    );
  }
});
it("offers original, solid and image backgrounds for outline styles", async () => {
  vi.mocked(invoke).mockImplementation(async (cmd) =>
    cmd === "highlight_runtime"
      ? { ready: true, reason: null }
      : { path: "/media/my-background.png", mediaType: "image" },
  );
  render(
    <FreezeHighlightPanel
      clip={project()
        .tracks.flatMap((t) => t.clips)
        .find((c) => c.id === "video")!}
    />,
  );
  fireEvent.change(screen.getByLabelText("Visual style"), { target: { value: "paper-outline" } });
  const mode = screen.getByLabelText("Outline background mode");
  fireEvent.change(mode, { target: { value: "original" } });
  expect(mode).toHaveValue("original");
  fireEvent.change(mode, { target: { value: "color" } });
  expect(screen.getByLabelText("Outline background colour")).toBeInTheDocument();
  fireEvent.change(mode, { target: { value: "image" } });
  fireEvent.click(screen.getByRole("button", { name: /Choose background image/ }));
  expect(await screen.findByAltText("Selected outline background")).toBeInTheDocument();
  expect(screen.getByLabelText("Outline background image")).toHaveValue("/media/my-background.png");
});

it("keeps animated freeze backgrounds as video while leaving voice and later clips in place", () => {
  const custom = {
    ...settings,
    style: "outline" as const,
    backgroundMode: "image" as const,
    backgroundImage: "/m/background.png",
    backgroundMotion: "down" as const,
    backgroundWidth: 0.5,
    backgroundHeight: 0.5,
  };
  const media = {
    ...prepared,
    image: {
      path: "/cache/animated.mp4",
      mediaType: "video" as const,
      width: 1920,
      height: 1080,
      duration: 2,
    },
  };
  const layered = {
    ...media,
    layers: {
      subject: { ...media.image, path: "/cache/subject.webm", alpha: true },
      overlay: {
        path: "/cache/plate.png",
        mediaType: "image" as const,
        width: 1920,
        height: 1080,
        alpha: true,
      },
    },
  };
  const r = applyFreezeHighlight(project(), "video", 2, custom, layered);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expectValid(r.project);
  expect(r.project.assets.find((a) => a.path === media.image.path)?.type).toBe("video");
  expect(r.project.tracks.flatMap((t) => t.clips).find((c) => c.id === "later")?.timelineStart).toBe(9);
  expect(r.project.tracks.filter((t) => t.type === "audio").flatMap((t) => t.clips).length).toBe(1);
});
it("sets half and quarter image boxes, manual position and animation independently", async () => {
  vi.mocked(invoke).mockResolvedValue({ ready: true, reason: null });
  render(
    <FreezeHighlightPanel
      clip={project()
        .tracks.flatMap((t) => t.clips)
        .find((c) => c.id === "video")!}
    />,
  );
  fireEvent.change(screen.getByLabelText("Visual style"), { target: { value: "outline" } });
  fireEvent.change(screen.getByLabelText("Outline background mode"), { target: { value: "image" } });
  fireEvent.change(screen.getByLabelText("Outline background image"), { target: { value: "/m/img.png" } });
  fireEvent.click(screen.getByRole("button", { name: "Half" }));
  expect(screen.getByLabelText("Image width")).toHaveValue("100");
  expect(screen.getByLabelText("Image height")).toHaveValue("50");
  fireEvent.click(screen.getByRole("button", { name: "Quarter" }));
  expect(screen.getByLabelText("Image width")).toHaveValue("50");
  fireEvent.change(screen.getByLabelText("Image centre X"), { target: { value: "25" } });
  fireEvent.change(screen.getByLabelText("Image centre Y"), { target: { value: "75" } });
  fireEvent.change(screen.getByLabelText("Background image animation"), { target: { value: "shake" } });
  expect(screen.getByLabelText("Image centre X")).toHaveValue("25");
  expect(screen.getByLabelText("Image centre Y")).toHaveValue("75");
  expect(screen.getByLabelText("Background image animation")).toHaveValue("shake");
  await vi.waitFor(() =>
    expect(screen.getByRole("button", { name: "Apply Freeze Highlight" })).toBeEnabled(),
  );
});

it("creates independent image and subject tracks without mutating the source project", () => {
  const before = project();
  const snapshot = structuredClone(before);
  const custom = {
    ...settings,
    style: "outline" as const,
    backgroundMode: "image" as const,
    backgroundImage: "/m/picture.png",
    backgroundMotion: "right" as const,
    backgroundSpeed: 2,
  };
  const layered = {
    ...prepared,
    image: { path: "/cache/base.mp4", mediaType: "video" as const, width: 1920, height: 1080, duration: 2 },
    layers: {
      subject: {
        path: "/cache/subject.webm",
        mediaType: "video" as const,
        width: 1920,
        height: 1080,
        duration: 2,
        alpha: true,
      },
      overlay: {
        path: "/cache/plate.png",
        mediaType: "image" as const,
        width: 1920,
        height: 1080,
        alpha: true,
      },
    },
  };
  const r = applyFreezeHighlight(before, "video", 2, custom, layered);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(before).toEqual(snapshot);
  expectValid(r.project);
  const plate = r.project.tracks.find((t) => t.name === "Highlight image (editable)")!;
  const subject = r.project.tracks.find((t) => t.name === "Highlight subject")!;
  expect(subject.order).toBe(plate.order + 1);
  expect(plate.clips[0].sourceOut).toBe(1.5);
  expect(plate.clips[0].keyframes?.x?.at(-1)?.t).toBe(0.75);
  expect(r.project.assets.find((a) => a.id === plate.clips[0].assetId)?.alpha).toBe(true);
  expect(r.project.assets.find((a) => a.id === subject.clips[0].assetId)?.alpha).toBe(true);
});

it("accepts a full-frame opaque image plate and selects it after Apply with undo support", async () => {
  const custom = {
    ...settings,
    style: "outline" as const,
    backgroundMode: "image" as const,
    backgroundImage: "/m/picture.png",
  };
  const layered = {
    ...prepared,
    image: { path: "/cache/base.mp4", mediaType: "video" as const, width: 1920, height: 1080, duration: 2 },
    layers: {
      subject: {
        path: "/cache/subject.webm",
        mediaType: "video" as const,
        width: 1920,
        height: 1080,
        duration: 2,
        alpha: true,
      },
      overlay: { path: "/cache/full-plate.png", mediaType: "image" as const, width: 1920, height: 1080 },
    },
  };
  vi.mocked(invoke).mockResolvedValue(layered);
  const before = useProjectStore.getState().project;
  const result = await createFreezeHighlight("video", 2, custom);
  expect(result.ok).toBe(true);
  const p = useProjectStore.getState().project;
  expectValid(p);
  const image = p.tracks.find((t) => t.name === "Highlight image (editable)")!.clips[0];
  const { useSelectionStore } = await import("@/store/selection");
  expect(useSelectionStore.getState().selectedClipIds.includes(image.id)).toBe(true);
  expect(p.assets.find((a) => a.id === image.assetId)?.alpha).toBe(true);
  useProjectStore.getState().undo();
  expect(useProjectStore.getState().project).toBe(before);
});

it("accepts 9–15 second freezes, sends 15 to the backend and still respects source end", async () => {
  const p = project();
  p.assets = p.assets.map((a) => (a.id === IDS.vid ? { ...a, duration: 30 } : a));
  p.tracks[0].clips = p.tracks[0].clips.filter((c) => c.id === "video").map((c) => ({ ...c, sourceOut: 25 }));
  useProjectStore.getState().loadProject(p, "/test.cutvii", []);
  for (const duration of [9, 15])
    expect(freezeWindow(p, "video", 2, { ...settings, duration }).stop).toBe(2 + duration);
  expect(() => freezeWindow(p, "video", 2, { ...settings, duration: 15.1 })).toThrow();
  expect(freezeWindow(p, "video", 20, { ...settings, duration: 15 }).stop).toBe(25);
  render(<FreezeHighlightPanel clip={p.tracks[0].clips[0]} />);
  expect(screen.getByLabelText("Freeze duration (seconds)")).toHaveAttribute("max", "15");
  vi.mocked(invoke).mockResolvedValue(prepared);
  expect((await createFreezeHighlight("video", 2, { ...settings, duration: 15 })).ok).toBe(true);
  expect(invoke).toHaveBeenCalledWith("prepare_freeze_highlight", {
    request: expect.objectContaining({ seconds: 15, sourceIn: 2, sourceOut: 17 }),
  });
  expectValid(useProjectStore.getState().project);
});
