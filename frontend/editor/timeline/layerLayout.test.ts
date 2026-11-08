import {
  layerLayout,
  layerTargetAtY,
  insertLayerTrack,
  moveClipToNewLayer,
  cleanLayersAfterMove,
  deleteLayerTrack,
} from "./layerLayout";
import { makeProject, IDS, expectValid } from "@/test/makeProject";
import { addClip } from "./edit";
import { planPlacement, newDropPlacement } from "./placement";
import { ROW_HEIGHT } from "./geometry";

it("groups visual layers before audio with a full blank row in each section", () => {
  const p = makeProject(),
    layout = layerLayout(p.tracks);
  expect(layout.tracks.map((t) => t.type)).toEqual(["video", "video", "audio"]);
  expect(layout.zones.video).toBe(2 * ROW_HEIGHT);
  expect(layout.top(IDS.a1)).toBe(3 * ROW_HEIGHT);
  expect(layout.height).toBe(5 * ROW_HEIGHT);
  expect(layerTargetAtY(p.tracks, 1, 3)).toMatchObject({
    kind: "new-track",
    trackType: "video",
    beforeTrackId: IDS.v1,
    time: 3,
  });
  expect(layerTargetAtY(p.tracks, ROW_HEIGHT - 1, 3)).toMatchObject({
    kind: "new-track",
    beforeTrackId: IDS.v2,
  });
  expect(layerTargetAtY(p.tracks, ROW_HEIGHT / 2, 3)).toEqual({ kind: "track", trackId: IDS.v1, time: 3 });
});
it("creates a new layer at either edge and preserves existing relative compositing order", () => {
  const p = makeProject(),
    before = structuredClone(p);
  const inserted = insertLayerTrack(p, "video", "new", IDS.v2);
  expect(inserted.ok).toBe(true);
  if (!inserted.ok) return;
  expectValid(inserted.project);
  expect(p).toEqual(before);
  expect(inserted.project.tracks.map((t) => t.id)).toEqual([IDS.v1, "new", IDS.v2, IDS.a1]);
  expect(inserted.project.tracks.find((t) => t.id === IDS.v1)!.order).toBeLessThan(
    inserted.project.tracks.find((t) => t.id === IDS.v2)!.order,
  );
  const audio = insertLayerTrack(inserted.project, "audio", "new-audio", IDS.a1);
  expect(audio.ok).toBe(true);
  if (!audio.ok) return;
  expect(audio.project.tracks.map((t) => t.type)).toEqual(["video", "video", "video", "audio", "audio"]);
  expect(audio.project.tracks[3].id).toBe("new-audio");
});
it("redirects a new layer of the wrong kind to its own section", () => {
  const p = makeProject();
  const plan = planPlacement(
    p,
    newDropPlacement({ kind: "new-track", trackType: "video", beforeTrackId: IDS.v1, time: 2 }),
    { type: "audio", duration: 3 },
  );
  expect(plan).toMatchObject({
    trackId: null,
    trackType: "audio",
    beforeTrackId: null,
    adapted: true,
    start: 2,
  });
});
it("moves detached source audio to a new audio layer without changing trim, speed or keys", () => {
  const p = makeProject();
  const added = addClip(p, { assetId: IDS.aud, trackId: IDS.a1, start: 0, id: "sound", duration: 4 });
  if (!added.ok) throw new Error(added.error.message);
  const source = added.project.tracks.find((t) => t.id === IDS.a1)!.clips[0];
  const r = moveClipToNewLayer(added.project, "sound", 2, "sound-layer", IDS.a1);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expectValid(r.project);
  expect(r.project.tracks.find((t) => t.id === "sound-layer")?.clips[0]).toEqual({
    ...source,
    timelineStart: 2,
    trackId: "sound-layer",
  });
  expect(r.project.tracks.find((t) => t.id === IDS.a1)?.clips).toEqual([]);
});

it("cleanup ignores cancelled/invalid/no-op moves and deletion does not remove media", () => {
  const p = makeProject(),
    snapshot = structuredClone(p);
  expect(cleanLayersAfterMove(p, { ok: true, project: p })).toEqual({ ok: true, project: p });
  const failed = { ok: false as const, error: { code: "overlap" as const, message: "Overlap" } };
  expect(cleanLayersAfterMove(p, failed)).toBe(failed);
  expect(p).toEqual(snapshot);
  const deleted = deleteLayerTrack(p, IDS.a1);
  expect(deleted.ok).toBe(true);
  if (deleted.ok) expect(deleted.project.assets).toBe(p.assets);
  expect(deleteLayerTrack(p, "missing").ok).toBe(false);
});

it("uses actual track heights when targeting a lane or inserting a new layer", () => {
  const p = makeProject(),
    heights = { [IDS.v1]: 96, [IDS.v2]: 40, [IDS.a1]: 128 };
  const layout = layerLayout(p.tracks, heights);
  expect(layout.top(IDS.v2)).toBe(96);
  expect(layout.zones.video).toBe(136);
  expect(layout.top(IDS.a1)).toBe(200);
  expect(layout.height).toBe(392);
  expect(layerTargetAtY(p.tracks, 70, 2, heights)).toEqual({ kind: "track", trackId: IDS.v1, time: 2 });
  expect(layerTargetAtY(p.tracks, 98, 2, heights)).toMatchObject({
    kind: "new-track",
    beforeTrackId: IDS.v2,
  });
  expect(layerTargetAtY(p.tracks, 240, 2, heights)).toEqual({ kind: "track", trackId: IDS.a1, time: 2 });
});
