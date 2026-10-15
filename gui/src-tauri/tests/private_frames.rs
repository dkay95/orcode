#[path = "../src/private_frames.rs"]
mod private_frames;
use private_frames::{decode_frame, encode_frame, read_frame, BOOTSTRAP_HELLO, BOOTSTRAP_REPLY, PLATFORM_REQUEST, PLATFORM_REPLY};

#[test]
fn private_frames_bind_direction_and_bound_allocation_before_read() {
    for tag in [BOOTSTRAP_HELLO, BOOTSTRAP_REPLY, PLATFORM_REQUEST, PLATFORM_REPLY, 0xa1, 0xc1] {
        let encoded = encode_frame(tag, b"private").unwrap();
        assert_eq!(decode_frame(&encoded, &[tag]).unwrap(), (tag, b"private".to_vec()));
        assert!(decode_frame(&encoded, &[tag ^ 1]).is_err());
        assert!(decode_frame(&[encoded.clone(), vec![0]].concat(), &[tag]).is_err());
        assert!(decode_frame(&encoded[..encoded.len()-1], &[tag]).is_err());
    }
    assert!(encode_frame(PLATFORM_REQUEST, &[0; 4097]).is_err());
    assert!(encode_frame(0, b"anything").is_err());
    let bytes = [PLATFORM_REQUEST, 0xff, 0xff, 0xff, 0xff];
    let mut reader = std::io::Cursor::new(bytes);
    assert!(read_frame(&mut reader, &[PLATFORM_REQUEST]).is_err());
    assert_eq!(reader.position(), 5);
}
