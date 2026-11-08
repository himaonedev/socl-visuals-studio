import { makeProject, expectValid } from "@/test/makeProject";
import { defaultTextSpec } from "./text";
import { applyTextFlicker, DEFAULT_FLICKER } from "./textFlicker";
import { transformAt } from "./transform";
function fixture() {
  const p = makeProject();
  p.assets.push({ id: "text", type: "image", path: "/text.png", text: defaultTextSpec(1080) });
  p.tracks[0].clips = [
    {
      id: "text",
      assetId: "text",
      trackId: "v1",
      timelineStart: 2,
      sourceIn: 1,
      sourceOut: 5,
      volume: 0,
      x: 0,
      y: 0,
      scale: 1,
      opacity: 0.8,
      keyframes: {
        x: [
          { t: 1, v: 0 },
          { t: 5, v: 0.2 },
        ],
      },
    },
  ];
  return p;
}
for (const kind of ["blink", "neon", "pulse"] as const)
  it(`${kind} changes brightness, settles at base opacity and preserves position`, () => {
    const p = fixture(),
      before = structuredClone(p);
    const r = applyTextFlicker(p, "text", { ...DEFAULT_FLICKER, kind });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expectValid(r.project);
    expect(p).toEqual(before);
    const c = r.project.tracks[0].clips[0];
    expect(c.keyframes!.opacity!.length).toBeLessThanOrEqual(64);
    expect(c.keyframes!.opacity!.some((k) => k.v < 0.7)).toBe(true);
    expect(transformAt(c, 4).opacity).toBeCloseTo(0.8);
    expect(c.keyframes!.x).toEqual(p.tracks[0].clips[0].keyframes!.x);
  });
it("maps reversed and accelerated text to source time and clamps short clips", () => {
  const p = fixture();
  const c = p.tracks[0].clips[0];
  c.reversed = true;
  c.speed = 2;
  c.sourceOut = 1.6;
  const r = applyTextFlicker(p, "text", DEFAULT_FLICKER);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expectValid(r.project);
  const keys = r.project.tracks[0].clips[0].keyframes!.opacity!;
  expect(keys[0].t).toBeCloseTo(1);
  expect(keys.at(-1)!.t).toBeCloseTo(1.6);
  expect(keys[0].v).toBeCloseTo(0.8);
});
it("rejects invalid values and nontext selections", () => {
  for (const patch of [{ duration: NaN }, { speed: 8 }, { depth: -1 }])
    expect(applyTextFlicker(fixture(), "text", { ...DEFAULT_FLICKER, ...patch }).ok).toBe(false);
  expect(applyTextFlicker(fixture(), "missing", DEFAULT_FLICKER).ok).toBe(false);
});
