use std::{os::windows::ffi::OsStrExt, path::Path};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{GENERIC_READ, RPC_E_CHANGED_MODE},
        Graphics::Imaging::*,
        System::Com::*,
    },
};

pub(super) fn decode_fax(path: &Path, page: u32, expected: (u32, u32)) -> Result<Vec<u8>, String> {
    let length = u64::from(expected.0) * u64::from(expected.1);
    if length > 256 * 1024 * 1024 {
        return Err("Decoded TIFF fax exceeds the memory limit".into());
    }
    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    struct Apartment(bool);
    impl Drop for Apartment {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }
    // WIC is an OS codec, not a downloaded runtime. All COM objects are dropped
    // on this worker thread before its matching CoUninitialize call.
    unsafe {
        let result = CoInitializeEx(None, COINIT_MULTITHREADED);
        if result.is_err() && result != RPC_E_CHANGED_MODE {
            return Err(format!("Windows imaging initialization: {result:?}"));
        }
        let _apartment = Apartment(result.is_ok());
        let factory: IWICImagingFactory =
            CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("Windows TIFF codec: {e}"))?;
        let decoder = factory
            .CreateDecoderFromFilename(
                PCWSTR(name.as_ptr()),
                None,
                GENERIC_READ,
                WICDecodeMetadataCacheOnDemand,
            )
            .map_err(|e| format!("Windows TIFF decoder: {e}"))?;
        let frame = decoder
            .GetFrame(page)
            .map_err(|e| format!("TIFF fax page {}: {e}", page + 1))?;
        let (mut width, mut height) = (0, 0);
        frame
            .GetSize(&mut width, &mut height)
            .map_err(|e| e.to_string())?;
        if (width, height) != expected {
            return Err("Windows TIFF decoder dimensions disagree with TIFF tags".into());
        }
        let format = frame.GetPixelFormat().map_err(|e| e.to_string())?;
        if format != GUID_WICPixelFormatBlackWhite && format != GUID_WICPixelFormat1bppIndexed {
            return Err("Windows fax decoder returned an unexpected pixel format".into());
        }
        let converter = factory.CreateFormatConverter().map_err(|e| e.to_string())?;
        converter
            .Initialize(
                &frame,
                &GUID_WICPixelFormat8bppGray,
                WICBitmapDitherTypeNone,
                None,
                0.0,
                WICBitmapPaletteTypeCustom,
            )
            .map_err(|e| format!("TIFF fax pixel conversion: {e}"))?;
        let mut pixels = vec![0; length as usize];
        converter
            .CopyPixels(std::ptr::null(), width, &mut pixels)
            .map_err(|e| format!("TIFF fax pixel decode: {e}"))?;
        Ok(pixels)
    }
}
