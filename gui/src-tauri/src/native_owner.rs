//! Windows bootstrap syntax/correlation only. Accepting JSON here is NOT native owner proof.
//! The OS-authenticated bridge must separately retain engine/helper identities and Job ownership.

use serde::{Deserialize, Serialize};

const MAX_JS_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_BOOTSTRAP_MS: u64 = 30_000;

pub struct OwnerStartContext {
    pub child_pid: u32,
    pub generation: u64,
    pub pipe_instance_id: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CorrelatedOwnerHelloV1 {
    kind: String,
    version: u8,
    request_id: String,
    session_id: String,
    challenge: String,
    child_pid: u32,
    child_generation: u64,
    pipe_instance_id: String,
    deadline_at: u64,
}

impl CorrelatedOwnerHelloV1 {
    pub fn child_pid(&self) -> u32 {
        self.child_pid
    }
}

pub struct WindowsOwnerChallengeGate {
    expected: OwnerStartContext,
    last_time: u64,
    closed: bool,
}

fn token(value: &str) -> bool {
    (32..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

impl WindowsOwnerChallengeGate {
    pub fn new(expected: OwnerStartContext, now: u64) -> Result<Self, &'static str> {
        if expected.child_pid == 0
            || expected.generation == 0
            || expected.generation > MAX_JS_INTEGER
            || !token(&expected.pipe_instance_id)
            || now > MAX_JS_INTEGER
        {
            return Err("windows-owner-context-invalid");
        }
        Ok(Self {
            expected,
            last_time: now,
            closed: false,
        })
    }

    pub fn accept(
        &mut self,
        bytes: &[u8],
        now: u64,
    ) -> Result<CorrelatedOwnerHelloV1, &'static str> {
        if self.closed {
            return Err("windows-owner-gate-closed");
        }
        if now < self.last_time || now > MAX_JS_INTEGER {
            self.revoke();
            return Err("windows-owner-clock-invalid");
        }
        self.last_time = now;
        if bytes.len() > 4096 {
            return Err("windows-owner-payload-too-large");
        }
        let hello: CorrelatedOwnerHelloV1 =
            serde_json::from_slice(bytes).map_err(|_| "windows-owner-hello-invalid")?;
        if hello.deadline_at <= now {
            self.revoke();
            return Err("windows-owner-hello-expired");
        }
        if hello.kind != "windows-owner-hello"
            || hello.version != 1
            || hello.child_pid != self.expected.child_pid
            || hello.child_generation != self.expected.generation
            || hello.pipe_instance_id != self.expected.pipe_instance_id
            || hello.deadline_at > MAX_JS_INTEGER
            || hello.deadline_at - now > MAX_BOOTSTRAP_MS
            || !token(&hello.request_id)
            || !token(&hello.session_id)
            || !token(&hello.challenge)
        {
            return Err("windows-owner-hello-binding-invalid");
        }
        self.revoke();
        Ok(hello)
    }

    pub fn revoke(&mut self) {
        self.closed = true;
    }
}
