//! Decode the bundled branding directly instead of relying on a Windows
//! executable-resource fallback, which may be absent in a development runner.
pub fn window_icon() -> Result<tauri::image::Image<'static>, Box<dyn std::error::Error>> {
    let decoder = png::Decoder::new(std::io::Cursor::new(include_bytes!("../icons/icon.png").as_slice()));
    let mut reader = decoder.read_info()?;
    let mut bytes = vec![0; reader.output_buffer_size().ok_or("icon dimensions exceed PNG limits")?];
    let info = reader.next_frame(&mut bytes)?;
    if info.color_type != png::ColorType::Rgba || info.bit_depth != png::BitDepth::Eight {
        return Err("the bundled app icon must be an 8-bit RGBA PNG".into());
    }
    // A window/taskbar icon does not need a full 1024px bitmap. Average blocks
    // to retain the existing logo's antialiased lettering at a modest size.
    let width = info.width.min(128);
    let height = info.height.min(128);
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        for x in 0..width {
            let (x0,x1) = (x * info.width / width, (x+1) * info.width / width);
            let (y0,y1) = (y * info.height / height, (y+1) * info.height / height);
            let mut total = [0u64; 4];
            for py in y0..y1 { for px in x0..x1 {
                let at = ((py * info.width + px)*4) as usize;
                for channel in 0..4 { total[channel] += bytes[at+channel] as u64; }
            }}
            let count = ((x1-x0)*(y1-y0)) as u64;
            for value in total { rgba.push((value/count) as u8); }
        }
    }
    Ok(tauri::image::Image::new_owned(rgba,width,height))
}

#[cfg(test)]
mod tests {
    #[test]
    fn bundled_logo_decodes_to_a_visible_window_icon() {
        let icon = super::window_icon().unwrap();
        assert_eq!((icon.width(),icon.height()),(128,128));
        assert_eq!(icon.rgba().len(),128*128*4);
        assert!(icon.rgba().chunks_exact(4).any(|p| p[3] > 0 && p[0] > 100 && p[1] > 100));
    }
}
