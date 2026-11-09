import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { FacecamStylesPanel } from "@/components/inspector/FacecamStylesPanel";
import { makeProject, IDS, expectValid } from "@/test/makeProject";
import { useProjectStore } from "@/store/project";
import { usePlaybackStore } from "@/store/playback";
import { addClip } from "./edit";
import { projectDuration } from "./clips";
import {
  DEFAULT_FACECAM,
  FACECAM_STYLES,
  applyFacecamStyle,
  createFacecamStyle,
  facecamWindow,
} from "./facecamStyles";
import type { PreparedFreeze } from "./freezeHighlight";
const prepared: PreparedFreeze = {
  image: { path: "/cache/facecam.mp4", mediaType: "video", duration: 3, width: 1920, height: 1080 },
  audio: null,
  hasAudio: true,
};
function project() {
  const r = addClip(makeProject(), { assetId: IDS.vid, trackId: IDS.v1, start: 0, id: "video", duration: 8 });
  if (!r.ok) throw new Error(r.error.message);
  r.project.assets = r.project.assets.map((a) =>
    a.id === IDS.vid ? { ...a, width: 1920, height: 1080 } : a,
  );
  return r.project;
}
beforeEach(() => {
  useProjectStore.getState().loadProject(project(), "/test.cutvii", []);
  usePlaybackStore.setState({ playhead: 2, playing: false });
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "render_text") return "/cache/label.png";
    if (command === "highlight_runtime") return { ready: true, reason: null };
    if (command === "prepare_facecam_style") return prepared;
  });
});
it.each(FACECAM_STYLES)(
  "applies $name without changing duration, later timing or original audio",
  ({ id }) => {
    const p = project();
    const result = applyFacecamStyle(p, "video", 2, { ...DEFAULT_FACECAM, style: id }, prepared);
    if (!result.ok) throw new Error(result.error.message);
    expectValid(result.project);
    expect(projectDuration(result.project)).toBe(projectDuration(p));
    expect(result.project.tracks[0].clips.map((c) => c.timelineStart)).toEqual([0, 2, 5]);
    const sound = result.project.tracks.filter((t) => t.type === "audio").flatMap((t) => t.clips);
    expect(sound.filter((c) => c.assetId === IDS.vid)).toHaveLength(1);
    expect(sound.find((c) => c.assetId === IDS.vid)).toMatchObject({
      sourceIn: 0,
      sourceOut: 8,
      timelineStart: 0,
    });
    expect(p.tracks[0].clips).toHaveLength(1);
  },
);
it("supports separate glyphs, Unicode and reuse of repeated letters, then one Undo", async () => {
  const before = useProjectStore.getState().project;
  const result = await createFacecamStyle("video", 2, {
    ...DEFAULT_FACECAM,
    style: "backdrop-word",
    text: "A A你",
  });
  expect(result.ok).toBe(true);
  expect(vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "render_text")).toHaveLength(2);
  expect(invoke).toHaveBeenCalledWith(
    "prepare_facecam_style",
    expect.objectContaining({
      request: expect.objectContaining({
        plates: ["/cache/label.png", "", "/cache/label.png", "/cache/label.png"],
        sourceIn: 2,
        sourceOut: 5,
        seconds: 3,
      }),
    }),
  );
  expect(useProjectStore.getState().past).toHaveLength(1);
  useProjectStore.getState().undo();
  expect(useProjectStore.getState().project).toBe(before);
});
it("maps the rendered range through source trim and speed", async () => {
  const p = project();
  p.assets = p.assets.map((a) => (a.id === IDS.vid ? { ...a, duration: 20 } : a));
  p.tracks[0].clips[0] = { ...p.tracks[0].clips[0], sourceIn: 2, sourceOut: 18, speed: 2 };
  useProjectStore.getState().loadProject(p, "/test.cutvii", []);
  expect((await createFacecamStyle("video", 1, DEFAULT_FACECAM)).ok).toBe(true);
  expect(invoke).toHaveBeenCalledWith(
    "prepare_facecam_style",
    expect.objectContaining({
      request: expect.objectContaining({ sourceIn: 4, sourceOut: 10, speed: 2, seconds: 3 }),
    }),
  );
  expectValid(useProjectStore.getState().project);
});
it("rejects invalid duration, reversed sources, empty labels and non-finite values", () => {
  const p = project();
  for (const patch of [
    { duration: 31 },
    { strength: NaN },
    { text: "", style: "name-tag" as const },
    { x: 2 },
    { textSize: 0 },
  ])
    expect(() => facecamWindow(p, "video", 2, { ...DEFAULT_FACECAM, ...patch })).toThrow();
  p.tracks[0].clips[0].reversed = true;
  expect(() => facecamWindow(p, "video", 2, DEFAULT_FACECAM)).toThrow(/Forward/i);
});
it("does not apply a stale render to a changed project", async () => {
  vi.mocked(invoke).mockImplementation(async () => {
    useProjectStore.setState({ project: { ...project(), name: "changed" } });
    return prepared;
  });
  await expect(createFacecamStyle("video", 2, DEFAULT_FACECAM)).rejects.toThrow(/project changed/i);
  expect(useProjectStore.getState().past).toHaveLength(0);
});
it("cancels an in-flight render without applying an edit", async () => {
  let finish!: (value: PreparedFreeze) => void;
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "prepare_facecam_style"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : undefined,
  );
  const controller = new AbortController();
  const task = createFacecamStyle("video", 2, DEFAULT_FACECAM, controller.signal);
  const rejected = expect(task).rejects.toThrow();
  await waitFor(() => expect(finish).toBeDefined());
  controller.abort();
  finish(prepared);
  await rejected;
  expect(invoke).toHaveBeenCalledWith("cancel_ai_job");
  expect(useProjectStore.getState().past).toHaveLength(0);
});
it("offers all styles and editable labels and applies from the Motion panel", async () => {
  const p = useProjectStore.getState().project;
  render(<FacecamStylesPanel clip={p.tracks[0].clips[0]} />);
  expect(screen.getByLabelText("Facecam style").querySelectorAll("option")).toHaveLength(FACECAM_STYLES.length);
  fireEvent.change(screen.getByLabelText("Facecam style"), { target: { value: "name-tag" } });
  fireEvent.change(screen.getByLabelText("Facecam text"), { target: { value: "Pembicara" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Apply Facecam Style" })));
  await waitFor(() => expect(useProjectStore.getState().past).toHaveLength(1));
  expect(invoke).toHaveBeenCalledWith(
    "render_text",
    expect.objectContaining({ spec: expect.objectContaining({ content: "Pembicara" }) }),
  );
});

it('renders Cinema Label as two native text rows without subject separation', async () => {
  const result = await createFacecamStyle('video', 2, { ...DEFAULT_FACECAM, style: 'cinema-label', text: 'WHERE THE\nMASK ENDS', x: .1, y: .1, textSize: .03, accent: '#E50914' });
  expect(result.ok).toBe(true);
  const rows = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'render_text');
  expect(rows.map(([, args]) => (args as { spec: { content: string } }).spec.content)).toEqual(['WHERE THE', 'MASK ENDS']);
  expect(invoke).toHaveBeenCalledWith('prepare_facecam_style', expect.objectContaining({ request: expect.objectContaining({ plates: ['/cache/label.png', '/cache/label.png'], settings: expect.objectContaining({ style: 'cinema-label', x: .1, y: .1 }) }) }));
});

it('offers a nine-point grid, X/Y and Zoom on every style and sends framing separately from the label', async () => {
  const p=useProjectStore.getState().project;
  render(<FacecamStylesPanel clip={p.tracks[0].clips[0]} />);
  for (const style of FACECAM_STYLES) {
    fireEvent.change(screen.getByLabelText('Facecam style'),{target:{value:style.id}});
    expect(screen.getByRole('group',{name:'Grid 9 titik Video/orang'}).querySelectorAll('button')).toHaveLength(9);
    expect(screen.getByRole('slider',{name:/Video\/orang Zoom/})).toBeInTheDocument();
  }
  fireEvent.change(screen.getByLabelText('Facecam style'),{target:{value:'name-tag'}});
  fireEvent.click(screen.getByRole('button',{name:'Video/orang: Kanan bawah'}));
  fireEvent.change(screen.getByRole('slider',{name:/Video\/orang Zoom/}),{target:{value:'150'}});
  fireEvent.change(screen.getByRole('slider',{name:/Teks\/kartu X/}),{target:{value:'30'}});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Apply Facecam Style'})));
  expect(invoke).toHaveBeenCalledWith('prepare_facecam_style',expect.objectContaining({request:expect.objectContaining({settings:expect.objectContaining({frameX:.8,frameY:.8,frameZoom:1.5,x:.3,y:.7})})}));
  fireEvent.click(screen.getByRole('button',{name:'Reset Video/orang'}));
  expect(screen.getByRole('slider',{name:/Video\/orang X/})).toHaveValue('50');
  expect(screen.getByRole('slider',{name:/Video\/orang Y/})).toHaveValue('50');
  expect(screen.getByRole('slider',{name:/Video\/orang Zoom/})).toHaveValue('100');
  expect(screen.getByRole('slider',{name:/Teks\/kartu X/})).toHaveValue('30');
});

it('offers slide, pop and combined entrance with direction, timing and delay in the rendered request', async () => {
  const p=useProjectStore.getState().project;
  render(<FacecamStylesPanel clip={p.tracks[0].clips[0]} />);
  expect(screen.queryByLabelText('Animasi masuk teks/kartu')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Facecam style'),{target:{value:'name-tag'}});
  fireEvent.change(screen.getByLabelText('Animasi masuk teks/kartu'),{target:{value:'pop'}});
  expect(screen.queryByLabelText('Arah masuk Facecam')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Animasi masuk teks/kartu'),{target:{value:'slide-pop'}});
  expect(screen.getByLabelText('Arah masuk Facecam').querySelectorAll('option')).toHaveLength(4);
  fireEvent.change(screen.getByLabelText('Arah masuk Facecam'),{target:{value:'bottom'}});
  fireEvent.change(screen.getByRole('slider',{name:/Durasi masuk Facecam/}),{target:{value:'.6'}});
  fireEvent.change(screen.getByRole('slider',{name:/Delay Facecam/}),{target:{value:'.2'}});
  fireEvent.click(screen.getByRole('button',{name:'Video/orang: Kanan atas'}));
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Apply Facecam Style'})));
  expect(invoke).toHaveBeenCalledWith('prepare_facecam_style',expect.objectContaining({request:expect.objectContaining({settings:expect.objectContaining({entry:'slide-pop',entryDirection:'bottom',entryDuration:.6,entryDelay:.2,frameX:.8,frameY:.2})})}));
});

it('rejects entrance timing that cannot finish within the available clip', () => {
  expect(()=>facecamWindow(project(),'video',7.5,{...DEFAULT_FACECAM,entry:'slide',entryDelay:.3,entryDuration:.4})).toThrow(/delay/);
  expect(()=>facecamWindow(project(),'video',2,{...DEFAULT_FACECAM,entryDuration:NaN})).toThrow();
});
