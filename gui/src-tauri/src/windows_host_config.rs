//! Closed helper launch context. These arguments identify peers; they grant no authority.
pub struct HostConfig {
    pub owner_pid: u32,
    pub owner_time: String,
    pub engine_pid: u32,
    pub generation: u64,
    pub pipe_name: String,
    pub instance: String,
}

impl HostConfig {
    pub fn parse(args: &[String]) -> Result<Self, &'static str> {
        const KEYS: [&str; 6] = [
            "--owner-pid",
            "--owner-time",
            "--engine-pid",
            "--generation",
            "--pipe",
            "--instance",
        ];
        if args.len() != 12
            || args
                .chunks_exact(2)
                .zip(KEYS)
                .any(|(pair, key)| pair[0] != key)
        {
            return Err("host-arguments-invalid");
        }
        let number = |value: &str| -> Result<u64, &'static str> {
            if value.is_empty()
                || value.starts_with('0')
                || !value.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err("host-number-invalid");
            }
            value.parse::<u64>().map_err(|_| "host-number-invalid")
        };
        let owner_pid = u32::try_from(number(&args[1])?).map_err(|_| "host-pid-invalid")?;
        number(&args[3])?;
        let engine_pid = u32::try_from(number(&args[5])?).map_err(|_| "host-pid-invalid")?;
        let generation = number(&args[7])?;
        if owner_pid == engine_pid || generation > 9_007_199_254_740_991 {
            return Err("host-identity-invalid");
        }
        if args[9]
            .strip_prefix("\\\\.\\pipe\\orcode-private-")
            .is_none_or(|suffix| {
                suffix.len() != 32
                    || !suffix
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
            || !(32..=128).contains(&args[11].len())
            || !args[11]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return Err("host-pipe-invalid");
        }
        Ok(Self {
            owner_pid,
            owner_time: args[3].clone(),
            engine_pid,
            generation,
            pipe_name: args[9].clone(),
            instance: args[11].clone(),
        })
    }
}
