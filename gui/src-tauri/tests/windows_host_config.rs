#[path = "../src/windows_host_config.rs"]
mod windows_host_config;
use windows_host_config::HostConfig;

#[test]
fn helper_startup_accepts_only_closed_nonsecret_identity_arguments() {
    let args = vec![
        "--owner-pid",
        "12",
        "--owner-time",
        "133000000000000001",
        "--engine-pid",
        "13",
        "--generation",
        "7",
        "--pipe",
        "\\\\.\\pipe\\orcode-private-0123456789abcdef0123456789abcdef",
        "--instance",
        "0123456789abcdef0123456789abcdef",
    ];
    let strings = |args: &[&str]| {
        args.iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
    };
    let parsed = HostConfig::parse(&strings(&args)).unwrap();
    assert_eq!(parsed.owner_pid, 12);
    assert_eq!(parsed.engine_pid, 13);
    assert_eq!(parsed.generation, 7);
    for (index, wrong) in [
        (0, "--command"),
        (1, "0"),
        (3, "0133000000000000001"),
        (5, "12"),
        (7, "0"),
        (
            9,
            "\\\\remote\\pipe\\orcode-private-0123456789abcdef0123456789abcdef",
        ),
        (11, "bad"),
    ] {
        let mut altered = args.clone();
        altered[index] = wrong;
        assert!(HostConfig::parse(&strings(&altered)).is_err());
    }
    let mut extra = strings(&args);
    extra.extend(["--raw-handle".into(), "100".into()]);
    assert!(HostConfig::parse(&extra).is_err());
    let mut duplicate = strings(&args);
    duplicate[4] = "--owner-pid".into();
    assert!(HostConfig::parse(&duplicate).is_err());
    assert!(HostConfig::parse(&strings(&args[..args.len() - 1])).is_err());
}
