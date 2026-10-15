//! Framing only. A decoded frame is never a native capability.
use std::io::{self, Read};

pub const BOOTSTRAP_HELLO: u8 = 0xb0;
pub const BOOTSTRAP_REPLY: u8 = 0xb1;
pub const PLATFORM_REQUEST: u8 = 0xd1;
pub const PLATFORM_REPLY: u8 = 0xd2;
pub const PLATFORM_CHUNK: u8 = 0xd3;
pub const MAX_PAYLOAD: usize = 4096;

fn valid_tag(tag: u8) -> bool {
    matches!(tag, BOOTSTRAP_HELLO | BOOTSTRAP_REPLY | PLATFORM_REQUEST | PLATFORM_REPLY | PLATFORM_CHUNK | 0xa1 | 0xc1)
}
fn malformed() -> io::Error { io::Error::new(io::ErrorKind::InvalidData, "private-frame-invalid") }

pub fn encode_frame(tag: u8, payload: &[u8]) -> io::Result<Vec<u8>> {
    if !valid_tag(tag) || payload.len() > MAX_PAYLOAD { return Err(malformed()); }
    let mut frame = Vec::with_capacity(5 + payload.len());
    frame.push(tag); frame.extend_from_slice(&(payload.len() as u32).to_be_bytes()); frame.extend_from_slice(payload);
    Ok(frame)
}

pub fn read_frame(reader: &mut impl Read, allowed: &[u8]) -> io::Result<(u8, Vec<u8>)> {
    let mut header = [0u8; 5]; reader.read_exact(&mut header)?;
    let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
    if !valid_tag(header[0]) || !allowed.contains(&header[0]) || length > MAX_PAYLOAD { return Err(malformed()); }
    let mut payload = vec![0u8; length]; reader.read_exact(&mut payload)?;
    Ok((header[0], payload))
}

pub fn decode_frame(bytes: &[u8], allowed: &[u8]) -> io::Result<(u8, Vec<u8>)> {
    let mut reader = std::io::Cursor::new(bytes);
    let frame = read_frame(&mut reader, allowed)?;
    if reader.position() != bytes.len() as u64 { return Err(malformed()); }
    Ok(frame)
}
