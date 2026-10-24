use super::{read_uint, TiffIndex};
use std::{
    collections::BTreeMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

// A read-only TIFF view. Only the selected directory/header is replaced;
// all compressed pixels and out-of-line tag values stay in the original file.
pub(super) struct PageReader {
    file: File,
    file_len: u64,
    position: u64,
    header: Vec<u8>,
    directory_at: u64,
    directory: Vec<u8>,
}

fn integer(bytes: &[u8], little: bool) -> u64 {
    let mut value = [0; 8];
    if little {
        value[..bytes.len()].copy_from_slice(bytes);
        u64::from_le_bytes(value)
    } else {
        value[8 - bytes.len()..].copy_from_slice(bytes);
        u64::from_be_bytes(value)
    }
}

fn encoded(value: u64, size: usize, little: bool) -> Vec<u8> {
    if little {
        value.to_le_bytes()[..size].to_vec()
    } else {
        value.to_be_bytes()[8 - size..].to_vec()
    }
}

impl PageReader {
    pub(super) fn new(
        path: &Path,
        index: &TiffIndex,
        offset: u64,
        overrides: &[(u16, u32)],
    ) -> Result<Self, String> {
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let file_len = file.metadata().map_err(|e| e.to_string())?.len();
        let (count_size, entry_size, pointer_size) =
            if index.big { (8, 20, 8) } else { (2, 12, 4) };
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let count = read_uint(&mut file, count_size, index.little_endian)?;
        if count > 65535 {
            return Err("TIFF directory has too many fields".into());
        }
        let end = offset
            .checked_add(count_size as u64 + count * entry_size as u64 + pointer_size as u64)
            .filter(|end| *end <= file_len)
            .ok_or("Truncated TIFF directory")?;
        let mut entries = BTreeMap::new();
        for _ in 0..count {
            let mut bytes = vec![0; entry_size];
            file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
            let tag = integer(&bytes[..2], index.little_endian) as u16;
            if entries.insert(tag, bytes).is_some() {
                return Err("Duplicate TIFF tag".into());
            }
        }
        let scalar = |tag: u16| -> Option<u64> {
            let bytes = entries.get(&tag)?;
            let field_type = integer(&bytes[2..4], index.little_endian);
            let (count_end, value_at) = if index.big { (12, 12) } else { (8, 8) };
            if integer(&bytes[4..count_end], index.little_endian) != 1 {
                return None;
            }
            let size = match field_type {
                3 => 2,
                4 => 4,
                16 if index.big => 8,
                _ => return None,
            };
            Some(integer(
                &bytes[value_at..value_at + size],
                index.little_endian,
            ))
        };
        let mut updates = overrides.to_vec();
        if !entries.contains_key(&279) || scalar(279) == Some(0) {
            // Recover only an unambiguous, complete single JPEG at the end of a
            // single-page file. Multi-strip/multipage lengths are never guessed.
            if scalar(259) == Some(7)
                && !entries.contains_key(&324)
                && index.offsets.len() == 1
                && index.issue.is_none()
            {
                let start = scalar(273).ok_or(
                    "Cannot recover missing TIFF StripByteCounts: expected one JPEG strip",
                )?;
                let height = scalar(257).ok_or("Missing TIFF height")?;
                if start < end
                    || start >= file_len
                    || (entries.contains_key(&278) && scalar(278).is_none_or(|rows| rows < height))
                {
                    return Err("Cannot safely recover TIFF JPEG strip bounds".into());
                }
                let length = file_len - start;
                if !(4..=256 * 1024 * 1024).contains(&length) {
                    return Err("Invalid TIFF JPEG strip size".into());
                }
                let mut marker = [0; 2];
                file.seek(SeekFrom::Start(start))
                    .map_err(|e| e.to_string())?;
                file.read_exact(&mut marker).map_err(|e| e.to_string())?;
                if marker != [0xff, 0xd8] {
                    return Err("Missing TIFF JPEG start marker".into());
                }
                file.seek(SeekFrom::End(-2)).map_err(|e| e.to_string())?;
                file.read_exact(&mut marker).map_err(|e| e.to_string())?;
                if marker != [0xff, 0xd9] {
                    return Err("Truncated TIFF JPEG: missing end marker".into());
                }
                updates.push((279, length as u32));
            }
        }
        let mut header = index.header.clone();
        let mut directory = Vec::new();
        let mut directory_at = file_len;
        let target = if updates.is_empty() {
            offset
        } else {
            directory_at = file_len.checked_add(7).ok_or("TIFF size overflow")? & !7;
            if !index.big && directory_at > u64::from(u32::MAX) {
                return Err("Classic TIFF directory offset overflow".into());
            }
            for (tag, value) in updates {
                let mut entry = encoded(u64::from(tag), 2, index.little_endian);
                entry.extend(encoded(4, 2, index.little_endian));
                entry.extend(encoded(
                    1,
                    if index.big { 8 } else { 4 },
                    index.little_endian,
                ));
                entry.extend(encoded(u64::from(value), 4, index.little_endian));
                entry.resize(entry_size, 0);
                entries.insert(tag, entry);
            }
            if !index.big && entries.len() > u16::MAX as usize {
                return Err("Classic TIFF directory has too many fields".into());
            }
            directory.extend(encoded(
                entries.len() as u64,
                count_size,
                index.little_endian,
            ));
            for entry in entries.into_values() {
                directory.extend(entry);
            }
            directory.extend(vec![0; pointer_size]);
            directory_at
        };
        let pointer_at = if index.big { 8 } else { 4 };
        header[pointer_at..pointer_at + pointer_size].copy_from_slice(&encoded(
            target,
            pointer_size,
            index.little_endian,
        ));
        Ok(Self {
            file,
            file_len,
            position: 0,
            header,
            directory_at,
            directory,
        })
    }

    fn len(&self) -> u64 {
        self.directory_at + self.directory.len() as u64
    }
}

impl Read for PageReader {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let count = bytes
            .len()
            .min(self.len().saturating_sub(self.position) as usize);
        if count == 0 {
            return Ok(0);
        }
        let start = self.position;
        let end = start + count as u64;
        bytes[..count].fill(0);
        if start < self.file_len {
            let from_file = (self.file_len - start).min(count as u64) as usize;
            self.file.seek(SeekFrom::Start(start))?;
            self.file.read_exact(&mut bytes[..from_file])?;
        }
        if start < self.header.len() as u64 {
            let n = count.min(self.header.len() - start as usize);
            bytes[..n].copy_from_slice(&self.header[start as usize..start as usize + n]);
        }
        if end > self.directory_at && !self.directory.is_empty() {
            let at = start.max(self.directory_at);
            let n = (end - at) as usize;
            bytes[(at - start) as usize..(at - start) as usize + n].copy_from_slice(
                &self.directory
                    [(at - self.directory_at) as usize..(at - self.directory_at) as usize + n],
            );
        }
        self.position = end;
        Ok(count)
    }
}

impl Seek for PageReader {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        let position = match position {
            SeekFrom::Start(n) => Some(n),
            SeekFrom::Current(n) => self.position.checked_add_signed(n),
            SeekFrom::End(n) => self.len().checked_add_signed(n),
        }
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid TIFF seek")
        })?;
        self.position = position;
        Ok(position)
    }
}
