//! Freeze Highlight: local duotone/halftone frames and short sound accents.
use crate::errors::{AppError, AppResult};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    #[serde(default = "default_playback")]
    pub playback: String,
    #[serde(default = "default_style")]
    pub style: String,
    #[serde(default = "default_paper")]
    pub paper_color: String,
    #[serde(default = "default_background")]
    pub background_mode: String,
    #[serde(default = "default_outline")]
    pub background_color: String,
    #[serde(default)]
    pub background_image: String,
    #[serde(default = "default_one")]
    pub background_width: f64,
    #[serde(default = "default_one")]
    pub background_height: f64,
    #[serde(default = "default_half")]
    pub background_x: f64,
    #[serde(default = "default_half")]
    pub background_y: f64,
    #[serde(default = "default_cover")]
    pub background_fit: String,
    #[serde(default = "default_original")]
    pub background_base: String,
    #[serde(default = "default_no_motion")]
    pub background_motion: String,
    #[serde(default = "default_outline")]
    pub outline_color: String,
    #[serde(default = "default_outline_width")]
    pub outline_width: f64,
    #[serde(default = "default_subject_zoom")]
    pub subject_zoom: f64,
    pub color: String,
    pub dark_color: String,
    pub opacity: f64,
    pub spacing: f64,
    pub intensity: f64,
    #[serde(default = "default_pattern")]
    pub pattern: String,
    #[serde(default = "default_bend")]
    pub bend: f64,
    pub audio: String,
    pub audio_strength: f64,
}
fn default_no_motion() -> String {
    "none".into()
}
fn default_one() -> f64 {
    1.0
}
fn default_half() -> f64 {
    0.5
}
fn default_cover() -> String {
    "cover".into()
}
fn default_original() -> String {
    "original".into()
}
fn default_background() -> String {
    "styled".into()
}
fn default_playback() -> String {
    "freeze".into()
}
fn default_style() -> String {
    "halftone".into()
}
fn default_paper() -> String {
    "#EFE6D8".into()
}
fn default_outline() -> String {
    "#FFFFFF".into()
}
fn default_outline_width() -> f64 {
    14.0
}
fn default_subject_zoom() -> f64 {
    1.12
}
fn default_pattern() -> String {
    "grid".into()
}
fn default_bend() -> f64 {
    0.6
}

// Warp the dot lattice, not the source picture: the person's silhouette stays in place.
fn dot_coordinates(x: f64, y: f64, width: u32, height: u32, cell: f64, s: &Settings) -> (f64, f64) {
    let (sin, cos) = 20f64.to_radians().sin_cos();
    let (mut u, mut v) = (cos * x + sin * y, -sin * x + cos * y);
    let size = width as f64;
    let tau = std::f64::consts::TAU;
    if s.pattern == "wave" {
        let amount = s.bend * size * 0.065;
        u += amount * (tau * y / (size * 0.75) + 0.65 * (tau * x / (size * 1.3)).sin()).sin();
        v += amount * 0.8 * (tau * x / (size * 0.9) + 0.6 * (tau * y / (size * 1.1)).sin()).sin();
    } else if s.pattern == "radial" {
        let (dx, dy) = (x - size * 0.5, y - height as f64 * 0.5);
        let radius = dx.hypot(dy);
        let angle = dy.atan2(dx);
        v = radius + s.bend * size * 0.025 * (angle * 4.0 + radius / (size * 0.2)).sin();
        let ring = (v / cell).floor().max(0.0);
        let count = (tau * (ring + 0.5)).round().max(6.0);
        u = angle / tau * count * cell;
    }
    (
        u.rem_euclid(cell) - cell / 2.0,
        v.rem_euclid(cell) - cell / 2.0,
    )
}
fn rgb(s: &str) -> Option<[f64; 3]> {
    if s.len() != 7 || !s.starts_with('#') || !s[1..].bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some([
        u8::from_str_radix(&s[1..3], 16).ok()? as f64,
        u8::from_str_radix(&s[3..5], 16).ok()? as f64,
        u8::from_str_radix(&s[5..7], 16).ok()? as f64,
    ])
}
impl Settings {
    pub fn validate(&self) -> AppResult<()> {
        if !matches!(self.playback.as_str(), "freeze" | "moving")
            || !matches!(
                self.style.as_str(),
                "halftone" | "mono" | "outline" | "paper-outline" | "paper"
            )
            || !matches!(
                self.background_mode.as_str(),
                "styled" | "original" | "color" | "image"
            )
            || !matches!(
                self.background_motion.as_str(),
                "none" | "down" | "up" | "left" | "right" | "shake"
            )
            || !(0.05..=2.0).contains(&self.background_width)
            || !(0.05..=2.0).contains(&self.background_height)
            || !(0.0..=1.0).contains(&self.background_x)
            || !(0.0..=1.0).contains(&self.background_y)
            || !matches!(self.background_fit.as_str(), "cover" | "contain")
            || !matches!(
                self.background_base.as_str(),
                "original" | "styled" | "color"
            )
            || rgb(&self.background_color).is_none()
            || (matches!(self.style.as_str(), "outline" | "paper-outline")
                && self.background_mode == "image"
                && self.background_image.is_empty())
            || rgb(&self.paper_color).is_none()
            || rgb(&self.outline_color).is_none()
            || !(1.0..=40.0).contains(&self.outline_width)
            || !(1.0..=1.4).contains(&self.subject_zoom)
            || rgb(&self.color).is_none()
            || rgb(&self.dark_color).is_none()
            || !(0.0..=1.0).contains(&self.opacity)
            || !(0.0..=1.0).contains(&self.intensity)
            || !(0.0..=1.0).contains(&self.bend)
            || !matches!(self.pattern.as_str(), "grid" | "wave" | "radial")
            || !(2.0..=20.0).contains(&self.spacing)
            || !(0.0..=1.0).contains(&self.audio_strength)
            || !matches!(self.audio.as_str(), "none" | "echo" | "reverb" | "impact")
        {
            return Err(AppError::InvalidInput(
                "invalid Freeze Highlight settings".into(),
            ));
        }
        Ok(())
    }
}
pub fn stylize(input: &[u8], width: u32, height: u32, s: &Settings) -> AppResult<Vec<u8>> {
    s.validate()?;
    if input.len() != width as usize * height as usize * 3 || width == 0 || height == 0 {
        return Err(AppError::InvalidInput("unreadable freeze frame".into()));
    }
    if matches!(s.style.as_str(), "outline" | "paper-outline") {
        return Ok(input.to_vec());
    }
    let light = rgb(&s.color).unwrap();
    let paper_colour = rgb(&s.paper_color).unwrap();
    let dark = rgb(&s.dark_color).unwrap();
    let cell = (s.spacing * width as f64 / 1080.0).clamp(2.0, 40.0);
    let mut out = input.to_vec();
    for (i, p) in input.chunks_exact(3).enumerate() {
        let (x, y) = ((i % width as usize) as f64, (i / width as usize) as f64);
        let l = (0.2126 * p[0] as f64 + 0.7152 * p[1] as f64 + 0.0722 * p[2] as f64) / 255.0;
        let (u, v) = dot_coordinates(x, y, width, height, cell, s);
        let radius = (1.0 - l).sqrt() * cell * 0.7;
        let paper = (u.hypot(v) - radius + 0.5).clamp(0.0, 1.0);
        let tone = l * (1.0 - s.intensity) + paper * s.intensity;
        for k in 0..3 {
            let contrast = ((l - 0.5) * 1.12 + 0.5).clamp(0.0, 1.0);
            let hash = (x as u32)
                .wrapping_mul(374761393)
                .wrapping_add((y as u32).wrapping_mul(668265263));
            let hash = (hash ^ (hash >> 13)).wrapping_mul(1274126177);
            let grain = ((hash & 65535) as f64 / 65535.0 - 0.5) * 15.0
                + (y * 0.85 + (x * 0.035).sin()).sin() * 1.5;
            let effect = match s.style.as_str() {
                "mono" => contrast * 255.0,
                "paper" => dark[k] + (paper_colour[k] - dark[k]) * contrast + grain * s.intensity,
                _ => dark[k] + (light[k] - dark[k]) * tone,
            };
            out[i * 3 + k] = (p[k] as f64 * (1.0 - s.opacity) + effect * s.opacity)
                .round()
                .clamp(0.0, 255.0) as u8;
        }
    }
    Ok(out)
}
pub fn tempo(speed: f64, keep_pitch: bool) -> String {
    if !keep_pitch {
        return format!("asetrate={:.6},aresample=48000,", 48000.0 * speed);
    }
    let mut factor = speed;
    let mut chain = String::new();
    while factor > 2.0 {
        chain.push_str("atempo=2,");
        factor /= 2.0;
    }
    while factor < 0.5 {
        chain.push_str("atempo=0.5,");
        factor /= 0.5;
    }
    chain.push_str(&format!("atempo={factor:.8},"));
    chain
}
pub fn impact_source(strength: f64) -> String {
    format!(
        "aevalsrc={:.6}*(sin(2*PI*65*t)+0.25*sin(2*PI*181*t))*exp(-18*t):s=48000:d=0.35",
        strength * 0.65
    )
}
pub fn impact_filter(seconds: f64) -> String {
    format!(
        "apad,atrim=duration={seconds:.6},afade=t=out:st=0.25:d=0.1,alimiter=limit=0.9:latency=1"
    )
}
pub fn audio_filter(
    s: &Settings,
    speed: f64,
    keep_pitch: bool,
    reversed: bool,
    seconds: f64,
    clean: &crate::project::AudioClean,
) -> String {
    let gain = s.audio_strength;
    let echo = if s.audio == "echo" {
        format!("aecho=0.8:0.9:150:{:.6},", gain * 0.65)
    } else {
        format!(
            "aecho=0.8:0.9:23|47|83|127:{:.6}|{:.6}|{:.6}|{:.6},",
            gain * 0.4,
            gain * 0.3,
            gain * 0.2,
            gain * 0.12
        )
    };
    format!(
        "aresample=48000,{}{}{}{}apad,atrim=duration={seconds:.6},asetpts=PTS-STARTPTS,afade=t=in:d=0.008,afade=t=out:st={:.6}:d=0.015,alimiter=limit=0.95:latency=1",
        crate::media::clean::filters(clean),
        if reversed { "areverse," } else { "" },
        tempo(speed, keep_pitch),
        echo,
        (seconds - 0.015).max(0.0)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn settings() -> Settings {
        Settings {
            playback: default_playback(),
            style: default_style(),
            paper_color: default_paper(),
            background_mode: default_background(),
            background_color: default_outline(),
            background_image: String::new(),
            background_width: 1.0,
            background_height: 1.0,
            background_x: 0.5,
            background_y: 0.5,
            background_fit: default_cover(),
            background_base: default_original(),
            background_motion: default_no_motion(),
            outline_color: default_outline(),
            outline_width: default_outline_width(),
            subject_zoom: default_subject_zoom(),
            color: "#F3D24F".into(),
            dark_color: "#222222".into(),
            opacity: 1.0,
            spacing: 6.0,
            intensity: 0.8,
            pattern: "grid".into(),
            bend: 0.6,
            audio: "echo".into(),
            audio_strength: 0.5,
        }
    }
    #[test]
    fn monochrome_and_paper_styles_keep_legacy_defaults_and_validate_new_controls() {
        let input = vec![120, 60, 30, 80, 180, 200, 255, 240, 220];
        let mut s = settings();
        s.style = "mono".into();
        let gray = stylize(&input, 3, 1, &s).unwrap();
        assert!(gray.chunks_exact(3).all(|p| p[0] == p[1] && p[1] == p[2]));
        s.style = "paper".into();
        let paper = stylize(&input, 3, 1, &s).unwrap();
        assert_ne!(paper, gray);
        s.opacity = 0.0;
        assert_eq!(stylize(&input, 3, 1, &s).unwrap(), input);
        s.outline_width = 41.0;
        assert!(s.validate().is_err());
        let mut legacy = serde_json::to_value(settings()).unwrap();
        for key in [
            "style",
            "paperColor",
            "outlineColor",
            "outlineWidth",
            "subjectZoom",
        ] {
            legacy.as_object_mut().unwrap().remove(key);
        }
        let restored: Settings = serde_json::from_value(legacy).unwrap();
        assert_eq!(restored.style, "halftone");
        assert_eq!(restored.subject_zoom, 1.12);
    }
    #[test]
    fn dot_modes_are_distinct_and_legacy_settings_keep_the_grid() {
        let input = vec![170u8; 240 * 320 * 3];
        let mut s = settings();
        let grid = stylize(&input, 240, 320, &s).unwrap();
        s.pattern = "wave".into();
        s.bend = 0.0;
        assert_eq!(stylize(&input, 240, 320, &s).unwrap(), grid);
        s.bend = 0.75;
        let wave = stylize(&input, 240, 320, &s).unwrap();
        assert_ne!(wave, grid);
        assert_eq!(wave, stylize(&input, 240, 320, &s).unwrap());
        s.pattern = "radial".into();
        let radial = stylize(&input, 240, 320, &s).unwrap();
        assert_ne!(radial, wave);
        assert_ne!(radial, grid);
        let mut old = serde_json::to_value(settings()).unwrap();
        old.as_object_mut().unwrap().remove("pattern");
        old.as_object_mut().unwrap().remove("bend");
        let legacy: Settings = serde_json::from_value(old).unwrap();
        assert_eq!(stylize(&input, 240, 320, &legacy).unwrap(), grid);
        s.bend = f64::NAN;
        assert!(s.validate().is_err());
        s.bend = 0.6;
        s.pattern = "unknown".into();
        assert!(s.validate().is_err());
    }
    #[test]
    fn opacity_zero_preserves_source_and_texture_is_deterministic() {
        let input = vec![160u8; 128 * 64 * 3];
        let mut s = settings();
        s.opacity = 0.0;
        assert_eq!(stylize(&input, 128, 64, &s).unwrap(), input);
        s.opacity = 1.0;
        let a = stylize(&input, 128, 64, &s).unwrap();
        assert_ne!(a, input);
        assert_eq!(a, stylize(&input, 128, 64, &s).unwrap());
        assert!(a.chunks_exact(3).any(|p| p[0] > p[2] + 30));
        assert!(a.windows(3).any(|p| p != &a[..3]));
        s.spacing = f64::NAN;
        assert!(s.validate().is_err());
    }
    #[test]
    fn tempo_chains_cover_fast_slow_and_pitch_change() {
        assert!(tempo(8.0, true).contains("atempo=2,atempo=2,"));
        assert!(tempo(0.1, true).contains("atempo=0.5,"));
        assert!(tempo(2.0, false).contains("asetrate=96000"));
    }
    #[test]
    fn real_audio_filters_and_halftone_picture_render_correctly() {
        use crate::media::{
            MediaBackend,
            ffmpeg::FfmpegBackend,
            tools::{FFMPEG_ENV, command, locate_tool},
        };
        let Ok(ffmpeg) = locate_tool("ffmpeg", FFMPEG_ENV) else {
            eprintln!("SKIPPED: FFmpeg unavailable");
            return;
        };
        let backend = FfmpegBackend::locate().unwrap();
        let retained = std::env::var_os("CUTVII_FREEZE_SMOKE_DIR");
        let dir = retained
            .as_ref()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::env::temp_dir().join(format!("cutvii-freeze-smoke-{}", std::process::id()))
            });
        std::fs::create_dir_all(&dir).unwrap();
        let mut frame = command(&ffmpeg);
        frame.args(["-v", "error"]);
        if let Some(src) = std::env::var_os("CUTVII_FREEZE_SMOKE_SOURCE") {
            frame.arg("-i").arg(src);
        } else {
            frame.args(["-f", "lavfi", "-i", "testsrc2=s=540x960:r=1:d=1"]);
        }
        let frame = frame
            .args([
                "-frames:v",
                "1",
                "-vf",
                "scale=540:960",
                "-pix_fmt",
                "rgb24",
                "-f",
                "rawvideo",
                "-",
            ])
            .output()
            .unwrap();
        assert!(frame.status.success());
        let pixels = stylize(&frame.stdout, 540, 960, &settings()).unwrap();
        let picture = dir.join("halftone.png");
        {
            let mut encoder = png::Encoder::new(
                std::io::BufWriter::new(std::fs::File::create(&picture).unwrap()),
                540,
                960,
            );
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&pixels).unwrap();
            writer.finish().unwrap();
        }
        assert_eq!(backend.probe(&picture).unwrap().width, Some(540));
        for mode in ["wave", "radial"] {
            let mut s = settings();
            s.pattern = mode.into();
            s.bend = 0.75;
            s.spacing = 10.0;
            let pixels = stylize(&frame.stdout, 540, 960, &s).unwrap();
            let picture = dir.join(format!("halftone-{mode}.png"));
            let mut encoder = png::Encoder::new(
                std::io::BufWriter::new(std::fs::File::create(&picture).unwrap()),
                540,
                960,
            );
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&pixels).unwrap();
            writer.finish().unwrap();
        }
        for style in ["mono", "paper"] {
            let mut s = settings();
            s.style = style.into();
            let pixels = stylize(&frame.stdout, 540, 960, &s).unwrap();
            let file = dir.join(format!("style-{style}.png"));
            let mut encoder = png::Encoder::new(
                std::io::BufWriter::new(std::fs::File::create(file).unwrap()),
                540,
                960,
            );
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&pixels).unwrap();
            writer.finish().unwrap();
        }
        let input = dir.join("burst.wav");
        let made = command(&ffmpeg)
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "aevalsrc='if(lt(t,0.08),0.3*sin(2*PI*440*t),0)':s=48000:d=1.5",
                "-c:a",
                "pcm_s16le",
            ])
            .arg(&input)
            .status()
            .unwrap();
        assert!(made.success());
        for mode in ["echo", "reverb", "impact"] {
            let mut s = settings();
            s.audio = mode.into();
            let out = dir.join(format!("{mode}.wav"));
            let mut cmd = command(&ffmpeg);
            cmd.args(["-v", "error", "-y"]);
            if mode == "impact" {
                cmd.args(["-f", "lavfi", "-i", &impact_source(s.audio_strength)]);
            } else {
                cmd.arg("-i").arg(&input);
            }
            let chain = if mode == "impact" {
                impact_filter(1.5)
            } else {
                audio_filter(
                    &s,
                    1.0,
                    true,
                    false,
                    1.5,
                    &crate::project::AudioClean {
                        noise: 0.0,
                        rumble: false,
                    },
                )
            };
            let status = cmd
                .args([
                    "-af",
                    &chain,
                    "-ar",
                    "48000",
                    "-ac",
                    "2",
                    "-c:a",
                    "pcm_s16le",
                ])
                .arg(&out)
                .status()
                .unwrap();
            assert!(status.success(), "{mode}");
            assert!((backend.probe(&out).unwrap().duration.unwrap() - 1.5).abs() < 0.025);
            let samples = command(&ffmpeg)
                .args(["-v", "error", "-i"])
                .arg(&out)
                .args([
                    "-af",
                    "atrim=start=0.1:end=0.35",
                    "-ac",
                    "1",
                    "-f",
                    "f32le",
                    "-",
                ])
                .output()
                .unwrap();
            assert!(samples.status.success());
            let energy: f32 = samples
                .stdout
                .chunks_exact(4)
                .map(|s| f32::from_le_bytes(s.try_into().unwrap()).powi(2))
                .sum();
            assert!(
                energy > 0.001,
                "{mode} has an audible tail or accent, energy={energy}"
            );
        }
        // Speed/pitch/reverse also form valid FFmpeg audio chains.
        for (speed, pitch, reverse) in [(2.0, true, true), (0.5, false, false)] {
            let out = dir.join(format!("speed-{speed}.wav"));
            let chain = audio_filter(
                &settings(),
                speed,
                pitch,
                reverse,
                1.5 / speed,
                &crate::project::AudioClean {
                    noise: 0.0,
                    rumble: false,
                },
            );
            assert!(
                command(&ffmpeg)
                    .args(["-v", "error", "-y", "-i"])
                    .arg(&input)
                    .args(["-af", &chain, "-c:a", "pcm_s16le"])
                    .arg(&out)
                    .status()
                    .unwrap()
                    .success()
            );
            assert!((backend.probe(&out).unwrap().duration.unwrap() - 1.5 / speed).abs() < 0.025);
        }
        if retained.is_none() {
            std::fs::remove_dir_all(dir).unwrap();
        }
    }
}
