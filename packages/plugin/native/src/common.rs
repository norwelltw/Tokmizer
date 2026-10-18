use crate::platform::{self, Stream};
use serde::Deserialize;
use serde_json::json;
use std::env;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

pub const CAP: usize = 10 * 1024 * 1024;
pub const METADATA_CAP: usize = 64 * 1024;
pub const CAPTURING_ENV: &str = "TOKMIZER_EXEC_CAPTURING";
const POST_CAP: usize = CAP + 2 * 1024 * 1024;
const SPAWN_WAIT: Duration = Duration::from_millis(80);
pub const SPAWN_FRESH: Duration = Duration::from_secs(1);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Descriptor {
    pub protocol: u32,
    pub version: String,
    pub home: PathBuf,
    pub path: PathBuf,
    pub token: String,
}

impl Descriptor {
    pub fn authentic(&self) -> bool {
        self.protocol == 2
            && self.version == env!("CARGO_PKG_VERSION")
            && self.token.len() == 64
            && self
                .token
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }
}

pub struct Capture {
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

impl Capture {
    pub fn new() -> Self {
        Self {
            bytes: Vec::new(),
            truncated: false,
        }
    }

    pub fn append(&mut self, bytes: &[u8]) {
        let available = CAP - self.bytes.len();
        self.bytes
            .extend_from_slice(&bytes[..bytes.len().min(available)]);
        self.truncated |= bytes.len() > available;
    }

    pub fn text(&self) -> String {
        let mut bytes = self.bytes.as_slice();
        if self.truncated {
            let mut offset = 0;
            while let Err(error) = std::str::from_utf8(&bytes[offset..]) {
                if error.error_len().is_none() {
                    bytes = &bytes[..offset + error.valid_up_to()];
                    break;
                }
                offset += error.valid_up_to() + error.error_len().unwrap_or(1);
            }
        }
        String::from_utf8_lossy(bytes).into_owned()
    }
}

pub trait Channel {
    fn write_until(&mut self, bytes: &[u8], deadline: Instant) -> io::Result<()>;
    fn read_until(&mut self, bytes: &mut [u8], deadline: Instant) -> io::Result<()>;
}

pub fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "invalid processing endpoint")
}

pub fn processor_descriptor_name() -> String {
    format!("processing-{}.json", env!("CARGO_PKG_VERSION"))
}

pub fn tokmizer_home() -> Option<PathBuf> {
    platform::canonical(&platform::home()?)
}

#[cfg(unix)]
pub fn resolved(path: PathBuf) -> PathBuf {
    path.canonicalize().unwrap_or(path)
}

#[cfg(not(unix))]
pub fn resolved(path: PathBuf) -> PathBuf {
    path
}

fn current_exe() -> Option<PathBuf> {
    env::current_exe().ok().map(resolved)
}

pub fn sibling_script(variable: &str, relative: &str) -> Option<PathBuf> {
    env::var_os(variable).map(PathBuf::from).or_else(|| {
        current_exe()?
            .parent()?
            .parent()
            .map(|root| root.join(relative))
    })
}

pub fn bundled_executable() -> Option<PathBuf> {
    if env::var_os("TOKMIZER_SINGLE_EXEC").is_some_and(|value| value == "0") {
        return None;
    }
    let path = current_exe()?
        .parent()?
        .join(format!("tkr{}", env::consts::EXE_SUFFIX));
    path.is_file().then_some(path)
}

pub fn launch_candidates(
    variable: &str,
    relative: &str,
    words: &[&str],
    node_flags: &[&str],
    require_script: bool,
) -> Vec<Command> {
    let mut commands = Vec::new();
    if env::var_os(variable).is_none() {
        if let Some(path) = bundled_executable() {
            let mut command = Command::new(path);
            command.args(words);
            commands.push(command);
        }
    }
    if let Some(script) =
        sibling_script(variable, relative).filter(|script| !require_script || script.is_file())
    {
        let mut command =
            Command::new(env::var_os("TOKMIZER_NODE_BIN").unwrap_or_else(|| "node".into()));
        command.args(node_flags).arg(script);
        commands.push(command);
    }
    commands
}

pub fn remaining(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|value| !value.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "processing deadline exceeded"))
}

fn write_frame(stream: &mut impl Channel, body: &[u8], deadline: Instant) -> io::Result<()> {
    stream.write_until(&(body.len() as u32).to_be_bytes(), deadline)?;
    stream.write_until(body, deadline)
}

fn read_frame(stream: &mut impl Channel, maximum: usize, deadline: Instant) -> io::Result<Vec<u8>> {
    let mut header = [0u8; 4];
    stream.read_until(&mut header, deadline)?;
    let size = u32::from_be_bytes(header) as usize;
    if size > maximum {
        return Err(invalid());
    }
    let mut body = vec![0; size];
    stream.read_until(&mut body, deadline)?;
    Ok(body)
}

fn host() -> &'static str {
    let probes: &[(&str, &[&str])] = &[
        (
            "claude-code",
            &[
                "CLAUDECODE",
                "CLAUDE_CODE_ENTRYPOINT",
                "CLAUDE_CODE",
                "CLAUDE_CODE_VERSION",
                "ANTHROPIC_CLAUDE_CODE",
            ],
        ),
        (
            "codex",
            &[
                "CODEX_VERSION",
                "CODEX_CLI",
                "OPENAI_CODEX",
                "CODEX_THREAD_ID",
                "CODEX_SESSION_ID",
            ],
        ),
        (
            "cursor",
            &["CURSOR_AGENT", "CURSOR_VERSION", "CURSOR_TRACE_ID"],
        ),
        ("cline", &["CLINE_VERSION", "CLINE_API_KEY"]),
        ("aider", &["AIDER_VERSION", "AIDER_MODEL"]),
        ("qwen-code", &["QWEN_CODE"]),
        (
            "gemini-cli",
            &["GEMINI_CLI", "GEMINI_CLI_VERSION", "GEMINI_API_KEY"],
        ),
        ("windsurf", &["WINDSURF_VERSION", "WINDSURF_USER"]),
        (
            "copilot",
            &["GITHUB_COPILOT_VERSION", "COPILOT_INTEGRATION_ID"],
        ),
        ("opencode", &[]),
        ("amp", &[]),
        ("vibe", &[]),
        ("antigravity", &[]),
        ("openclaw", &[]),
        ("pi", &[]),
        ("omp", &[]),
        ("hermes", &[]),
        ("crush", &["CRUSH"]),
        ("droid", &[]),
        ("trae", &[]),
        ("junie", &[]),
        ("zcode", &[]),
        ("grok", &[]),
        ("kilo", &[]),
    ];
    if let Some(explicit) = env::var("TOKMIZER_HOST")
        .ok()
        .filter(|value| probes.iter().any(|(name, _)| *name == value) || value == "shell")
    {
        return probes
            .iter()
            .map(|(name, _)| *name)
            .chain(std::iter::once("shell"))
            .find(|name| *name == explicit)
            .unwrap_or("shell");
    }
    probes
        .iter()
        .find(|(_, names)| {
            names
                .iter()
                .any(|name| env::var_os(name).is_some_and(|value| !value.is_empty()))
        })
        .map(|(name, _)| *name)
        .unwrap_or("shell")
}

fn timeout_ms() -> Option<u64> {
    let explicit = env::var("TOKMIZER_EXEC_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0);
    let host = env::var("BASH_MAX_TIMEOUT_MS")
        .ok()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 600_000.0);
    let value = explicit.or(host).unwrap_or(600_000.0);
    if value.fract() != 0.0 || value > 86_400_000.0 {
        None
    } else {
        Some(value as u64)
    }
}

fn process(
    stream: &mut impl Channel,
    stdout: &str,
    stderr: &str,
    flags: u32,
    code: i32,
) -> io::Result<(Vec<u8>, Vec<u8>)> {
    if stdout.len() > CAP || stderr.len() > CAP {
        return Err(invalid());
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut request = Vec::with_capacity(16 + stdout.len() + stderr.len());
    for value in [code as u32, flags, stdout.len() as u32, stderr.len() as u32] {
        request.extend(value.to_be_bytes());
    }
    request.extend(stdout.as_bytes());
    request.extend(stderr.as_bytes());
    write_frame(stream, &request, deadline)?;
    let response = read_frame(stream, 8 + 2 * (CAP + METADATA_CAP), deadline)?;
    if response.len() < 8 {
        return Err(invalid());
    }
    let out = u32::from_be_bytes(response[..4].try_into().unwrap()) as usize;
    let err = u32::from_be_bytes(response[4..8].try_into().unwrap()) as usize;
    if out > CAP + METADATA_CAP || err > CAP + METADATA_CAP || response.len() != 8 + out + err {
        return Err(invalid());
    }
    Ok((response[8..8 + out].to_vec(), response[8 + out..].to_vec()))
}

pub fn native_environment_supported() -> bool {
    [
        "TOKMIZER_DEV",
        "TOKMIZER_FILTERS_DIR",
        "TOKMIZER_BASE_URL",
        "TOKMIZER_RESP_SIGNING_PUBLIC_KEY_PEM",
        "TOKMIZER_MAX_BUNDLE_AGE_MS",
    ]
    .iter()
    .all(|name| env::var_os(name).is_none())
}

fn endpoint_or_spawn(home: &std::path::Path) -> Option<(Descriptor, Stream)> {
    if let Some(found) = platform::endpoint(home) {
        return Some(found);
    }
    if !platform::spawn_processor(home) {
        return None;
    }
    let deadline = Instant::now() + SPAWN_WAIT;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(2));
        if let Some(found) = platform::endpoint(home) {
            return Some(found);
        }
    }
    None
}

fn warm_session() -> i32 {
    if !native_environment_supported() {
        return 0;
    }
    let Some(home) = platform::home() else {
        return 0;
    };
    if std::fs::symlink_metadata(&home).is_err() {
        platform::create_home(&home);
    }
    let Some(canonical) = platform::canonical(&home) else {
        return 0;
    };
    if platform::endpoint(&canonical).is_none() {
        let _ = platform::spawn_processor(&canonical);
    }
    0
}

pub fn session_start() -> i32 {
    let _ = io::stdin()
        .take(METADATA_CAP as u64)
        .read_to_end(&mut Vec::new());
    warm_session()
}

fn hook_fallback(input: Vec<u8>) -> i32 {
    platform::script_fallback(
        "TOKMIZER_PRE_TOOL_JS",
        "hooks-host/pre-tool-use.js",
        &["hook", "pre-tool-use"],
        input,
    )
}

fn hook_response(input: &[u8]) -> Option<(Stream, String)> {
    if !native_environment_supported() || input.len() > METADATA_CAP {
        return None;
    }
    let payload: serde_json::Value = serde_json::from_slice(input).ok()?;
    if !payload.is_object() {
        return None;
    }
    let canonical = tokmizer_home()?;
    let Some((descriptor, mut stream)) = platform::endpoint(&canonical) else {
        let _ = platform::spawn_processor(&canonical);
        return None;
    };
    let mut prepare = json!({ "kind": "pre-tool-use", "protocol": 2, "version": descriptor.version, "token": descriptor.token, "home": descriptor.home, "host": payload_host(&payload)?, "payload": payload });
    for (variable, field, limit) in [
        ("CLAUDE_PROJECT_DIR", "claudeProjectDir", 4096),
        ("CLAUDE_CONFIG_DIR", "claudeConfigDir", 4096),
        ("PATH", "path", 32768),
        ("CLAUDE_PID", "claudePid", 10),
    ] {
        match env::var(variable) {
            Ok(value) if value.is_empty() => {}
            Ok(value) if value.len() <= limit => prepare[field] = json!(value),
            Err(env::VarError::NotPresent) => {}
            _ => return None,
        }
    }
    let metadata = serde_json::to_vec(&prepare).ok()?;
    if metadata.len() > METADATA_CAP {
        return None;
    }
    let deadline = Instant::now() + Duration::from_millis(250);
    write_frame(&mut stream, &metadata, deadline).ok()?;
    let response: serde_json::Value =
        serde_json::from_slice(&read_frame(&mut stream, 1024 * 1024, deadline).ok()?).ok()?;
    if response["ok"] != true || response["protocol"] != 2 {
        return None;
    }
    Some((stream, response["output"].as_str()?.to_owned()))
}

pub fn hook() -> i32 {
    let mut input = Vec::new();
    if io::stdin()
        .take((METADATA_CAP + 1) as u64)
        .read_to_end(&mut input)
        .is_err()
    {
        return hook_fallback(input);
    }
    pre_tool(input)
}

fn pre_tool(input: Vec<u8>) -> i32 {
    if serde_json::from_slice::<serde_json::Value>(&input)
        .map(|payload| payload.is_object() && payload_host(&payload).is_none())
        .unwrap_or(false)
    {
        return 0;
    }
    let Some((mut stream, output)) = hook_response(&input) else {
        return hook_fallback(input);
    };
    if io::stdout()
        .write_all(output.as_bytes())
        .and_then(|_| io::stdout().flush())
        .is_err()
    {
        return 0;
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    if write_frame(&mut stream, &[1], deadline).is_ok() {
        let _ = read_frame(&mut stream, 1, deadline);
    }
    0
}

fn word_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn invokes_restore(command: &str) -> bool {
    let bytes = command.as_bytes();
    let mut index = 0;
    while let Some(found) = command[index..].find("tkr") {
        let start = index + found;
        index = start + 1;
        if start > 0 && word_byte(bytes[start - 1]) {
            continue;
        }
        let mut cursor = start + 3;
        if command[cursor..].starts_with(".js") {
            cursor += 3;
        }
        let spaces = command[cursor..]
            .bytes()
            .take_while(|byte| byte.is_ascii_whitespace() || *byte == 0x0b)
            .count();
        if spaces == 0 {
            continue;
        }
        cursor += spaces;
        if !command[cursor..].starts_with("restore") {
            continue;
        }
        cursor += 7;
        if cursor == bytes.len() || !word_byte(bytes[cursor]) {
            return true;
        }
    }
    false
}

fn text_field<'a>(payload: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    payload.get(key)?.as_str().filter(|value| !value.is_empty())
}

fn payload_host(payload: &serde_json::Value) -> Option<&'static str> {
    let codex = text_field(payload, "turn_id").is_some();
    let claude_only = text_field(payload, "prompt_id").is_some()
        || text_field(payload, "scratchpad_dir").is_some()
        || payload.get("effort").is_some_and(|value| value.is_object());
    match (codex, claude_only) {
        (true, true) => None,
        (true, false) => Some("codex"),
        _ => Some("claude-code"),
    }
}

fn post_needs_processing(payload: &serde_json::Value) -> bool {
    if payload_host(payload) != Some("claude-code") {
        return false;
    }
    let Some(tool) = payload.get("tool_name").and_then(|value| value.as_str()) else {
        return false;
    };
    if !matches!(tool, "Read" | "Grep" | "Glob" | "Bash") {
        return false;
    }
    if tool == "Bash" {
        let command = payload["tool_input"]["command"].as_str().unwrap_or("");
        if [
            "/tkr-exec'",
            "/tkr-exec.exe'",
            "/tkr-exec.js'",
            "/tkr-exec ",
            "/tkr-exec.exe ",
            "/tkr-exec.js ",
        ]
        .iter()
        .any(|launcher| command.contains(launcher))
            || invokes_restore(command)
        {
            return false;
        }
    }
    true
}

fn post_response(input: &[u8]) -> Option<(Stream, String)> {
    if !native_environment_supported() {
        return None;
    }
    let canonical = tokmizer_home()?;
    let (descriptor, mut stream) = endpoint_or_spawn(&canonical)?;
    let prepare = json!({ "kind": "post-tool-use", "protocol": 2, "version": descriptor.version, "token": descriptor.token, "home": descriptor.home, "host": "claude-code" });
    let metadata = serde_json::to_vec(&prepare).ok()?;
    if metadata.len() > METADATA_CAP {
        return None;
    }
    let deadline = Instant::now() + Duration::from_millis(250);
    write_frame(&mut stream, &metadata, deadline).ok()?;
    let ready: serde_json::Value =
        serde_json::from_slice(&read_frame(&mut stream, 1024, deadline).ok()?).ok()?;
    if ready["ok"] != true || ready["protocol"] != 2 {
        return None;
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    write_frame(&mut stream, input, deadline).ok()?;
    let response: serde_json::Value =
        serde_json::from_slice(&read_frame(&mut stream, 2 * CAP + METADATA_CAP, deadline).ok()?)
            .ok()?;
    if response["ok"] != true || response["protocol"] != 2 {
        return None;
    }
    Some((stream, response["output"].as_str()?.to_owned()))
}

fn post_fallback(input: Vec<u8>) -> i32 {
    platform::script_fallback(
        "TOKMIZER_POST_TOOL_JS",
        "hooks-host/post-tool-use.js",
        &["hook", "post-tool-use"],
        input,
    )
}

pub fn post_hook() -> i32 {
    let mut input = Vec::new();
    if io::stdin()
        .take((POST_CAP + 1) as u64)
        .read_to_end(&mut input)
        .is_err()
        || input.len() > POST_CAP
    {
        return post_fallback(input);
    }
    post_tool(input)
}

fn post_tool(input: Vec<u8>) -> i32 {
    let Ok(payload) = serde_json::from_slice::<serde_json::Value>(&input) else {
        return 0;
    };
    if !payload.is_object() || !post_needs_processing(&payload) {
        return 0;
    }
    let Some((mut stream, output)) = post_response(&input) else {
        return post_fallback(input);
    };
    if !output.is_empty()
        && io::stdout()
            .write_all(output.as_bytes())
            .and_then(|_| io::stdout().flush())
            .is_err()
    {
        return 0;
    }
    let deadline = Instant::now() + Duration::from_secs(1);
    if write_frame(&mut stream, &[1], deadline).is_ok() {
        let _ = read_frame(&mut stream, 1, deadline);
    }
    0
}

#[derive(Debug, PartialEq)]
enum HookEvent {
    PreToolUse,
    PostToolUse,
    SessionStart,
}

fn hook_event(input: &[u8]) -> Option<HookEvent> {
    let payload: serde_json::Value = serde_json::from_slice(input).ok()?;
    match payload.get("hook_event_name")?.as_str()? {
        "PreToolUse" => Some(HookEvent::PreToolUse),
        "PostToolUse" => Some(HookEvent::PostToolUse),
        "SessionStart" => Some(HookEvent::SessionStart),
        _ => None,
    }
}

pub fn untagged_hook() -> i32 {
    let mut input = Vec::new();
    if io::stdin()
        .take((POST_CAP + 1) as u64)
        .read_to_end(&mut input)
        .is_err()
        || input.len() > POST_CAP
    {
        return 0;
    }
    match hook_event(&input) {
        Some(HookEvent::PreToolUse) => pre_tool(input),
        Some(HookEvent::PostToolUse) => post_tool(input),
        Some(HookEvent::SessionStart) => warm_session(),
        None => 0,
    }
}

pub fn non_blocking(code: i32) -> i32 {
    if code == 2 {
        1
    } else {
        code
    }
}

pub fn run(args: &[OsString]) -> Option<i32> {
    if !native_environment_supported() {
        return None;
    }
    let home = platform::home()?;
    let canonical = platform::canonical(&home)?;
    let (descriptor, mut stream) = endpoint_or_spawn(&canonical)?;
    let timeout = timeout_ms()?;
    let argv = args
        .iter()
        .map(|arg| arg.to_str())
        .collect::<Option<Vec<_>>>()?;
    let disabled = matches!(
        env::var("TOKMIZER_CCR_DISABLED").as_deref(),
        Ok("1") | Ok("true")
    );
    let mut prepare = json!({ "protocol": 2, "version": descriptor.version, "token": descriptor.token, "home": descriptor.home, "argv": argv, "host": host(), "restoreDisabled": disabled, "timeoutMs": timeout });
    if let Some(session) = env::var_os("CLAUDE_CODE_SESSION_ID") {
        prepare["sessionId"] = json!(session.to_str()?);
    }
    if let Ok(value) = env::var("TOKMIZER_CCR_ENTRY_MAX_BYTES") {
        let parsed = value.parse::<u64>().ok()?;
        if parsed == 0 || parsed > CAP as u64 {
            return None;
        }
        prepare["restoreMaxBytes"] = json!(parsed);
    }
    let metadata = serde_json::to_vec(&prepare).ok()?;
    if metadata.len() > METADATA_CAP {
        return None;
    }
    let deadline = Instant::now() + Duration::from_millis(250);
    write_frame(&mut stream, &metadata, deadline).ok()?;
    let ready: serde_json::Value =
        serde_json::from_slice(&read_frame(&mut stream, 1024, deadline).ok()?).ok()?;
    if ready["ok"] != true || ready["protocol"] != 2 || !ready["yolo"].is_boolean() {
        return None;
    }
    let (out, err, code) = platform::capture(args, &home, timeout).ok()?;
    let mut stdout = out.text();
    let mut stderr = err.text();
    let flags = u32::from(out.truncated) | (u32::from(err.truncated) << 1);
    let processed = process(&mut stream, &stdout, &stderr, flags, code);
    let acknowledge = processed.is_ok();
    let delivered = processed.unwrap_or_else(|_| {
        if out.truncated {
            stdout.push_str("\n… (output truncated at 10MB)");
        }
        if err.truncated {
            stderr.push_str("\n… (stderr truncated at 10MB)");
        }
        (stdout.into_bytes(), stderr.into_bytes())
    });
    for result in [
        io::stdout().write_all(&delivered.0),
        io::stderr().write_all(&delivered.1),
        io::stdout().flush(),
        io::stderr().flush(),
    ] {
        if let Err(error) = result {
            return Some(if error.kind() == io::ErrorKind::BrokenPipe {
                0
            } else {
                1
            });
        }
    }
    if acknowledge {
        let deadline = Instant::now() + Duration::from_secs(1);
        if write_frame(&mut stream, &[1], deadline).is_ok() {
            let _ = read_frame(&mut stream, 1, deadline);
        }
    }
    Some(code)
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn resolved_follows_a_symlink_to_the_real_launcher_directory() {
        let base = std::env::temp_dir().join(format!("tkr-resolved-{}", std::process::id()));
        let real_dir = base.join("dist").join("bin");
        let link_dir = base.join("bin");
        std::fs::create_dir_all(&real_dir).unwrap();
        std::fs::create_dir_all(&link_dir).unwrap();
        let real = real_dir.join("tkr-exec");
        std::fs::write(&real, b"").unwrap();
        let link = link_dir.join("tkr-exec");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let got = super::resolved(link.clone());
        assert_eq!(got.parent().unwrap(), real_dir.canonicalize().unwrap());
        assert_eq!(super::resolved(base.join("missing")), base.join("missing"));
        std::fs::remove_dir_all(&base).unwrap();
    }

    use super::*;

    #[test]
    fn restore_invocations_match_the_hook_rule() {
        for command in [
            "tkr restore abc12345",
            "node tkr.js restore 0123abcd",
            "x && tkr\trestore f00d",
            "/bin/tkr restore 1",
        ] {
            assert!(invokes_restore(command), "{command}");
        }
        for command in [
            "tkrx restore 1",
            "mytkr restore 1",
            "tkr restored",
            "tkr gain",
            "echo tkr",
            "tkr.jsx restore 1",
            "tkrestore",
        ] {
            assert!(!invokes_restore(command), "{command}");
        }
    }

    #[test]
    fn wrapped_and_restore_commands_skip_post_processing() {
        let skip = |value: serde_json::Value| !post_needs_processing(&value);
        assert!(skip(
            json!({ "tool_name": "Bash", "tool_input": { "command": "'/p/tkr-exec' cat file" } })
        ));
        assert!(skip(
            json!({ "tool_name": "Bash", "tool_input": { "command": "'C:/p/dist/bin/tkr-exec.exe' cat file" } })
        ));
        assert!(skip(
            json!({ "tool_name": "Bash", "tool_input": { "command": "tkr restore 0123abcd" } })
        ));
        assert!(skip(json!({ "tool_name": "Edit", "tool_input": {} })));
        assert!(skip(json!({ "tool_input": {} })));
        assert!(!skip(
            json!({ "tool_name": "Bash", "tool_input": { "command": "cat file" } })
        ));
        assert!(!skip(
            json!({ "tool_name": "Bash", "tool_input": { "command": "grep -rn tkr-exec src" } })
        ));
        assert!(!skip(
            json!({ "tool_name": "Bash", "tool_input": { "command": "cat bin/tkr-exec.js" } })
        ));
        assert!(!skip(
            json!({ "tool_name": "Read", "tool_input": { "file_path": "/x" } })
        ));
        assert!(!skip(
            json!({ "tool_name": "Grep", "tool_input": { "pattern": "x" } })
        ));
        assert!(!skip(
            json!({ "tool_name": "Glob", "tool_input": { "pattern": "*" } })
        ));
        assert!(!skip(
            json!({ "tool_name": "Bash", "tool_input": { "command": 42 } })
        ));
    }

    #[test]
    fn capture_bounds_and_drops_partial_utf8_tail() {
        let mut capture = Capture::new();
        capture.append(&vec![b'x'; CAP - 2]);
        capture.append("😀tail".as_bytes());
        assert_eq!(capture.bytes.len(), CAP);
        assert!(capture.truncated);
        assert_eq!(capture.text().len(), CAP - 2);
    }

    #[test]
    fn complete_invalid_utf8_is_replaced() {
        let mut capture = Capture::new();
        capture.append(&[b'a', 0xff, b'b']);
        assert_eq!(capture.text(), "a�b");
    }

    #[test]
    fn partial_tail_after_multiple_invalid_sequences_is_dropped() {
        let capture = Capture {
            bytes: vec![0xff, 0xff, 0xe2, 0x82],
            truncated: true,
        };
        assert_eq!(capture.text(), "��");
    }

    #[test]
    fn untagged_payloads_route_by_hook_event_name() {
        let event = |value: serde_json::Value| hook_event(value.to_string().as_bytes());
        assert_eq!(
            event(json!({ "hook_event_name": "PreToolUse", "tool_name": "Bash" })),
            Some(HookEvent::PreToolUse)
        );
        assert_eq!(
            event(json!({ "hook_event_name": "PostToolUse", "tool_name": "Read" })),
            Some(HookEvent::PostToolUse)
        );
        assert_eq!(
            event(json!({ "hook_event_name": "SessionStart", "source": "startup" })),
            Some(HookEvent::SessionStart)
        );
        assert_eq!(event(json!({ "hook_event_name": "Stop" })), None);
        assert_eq!(event(json!({ "hook_event_name": 1 })), None);
        assert_eq!(event(json!({ "tool_name": "Bash" })), None);
        assert_eq!(event(json!(["PreToolUse"])), None);
        assert_eq!(hook_event(b""), None);
        assert_eq!(hook_event(b"not json"), None);
        assert_eq!(hook_event(&[0xff, 0x00]), None);
    }

    #[test]
    fn payload_shape_picks_the_calling_host() {
        let codex = json!({ "session_id": "s", "turn_id": "t1", "model": "gpt-5.5", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": { "command": "git status" }, "tool_use_id": "call_1" });
        let claude = json!({ "session_id": "s", "prompt_id": "p", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": { "command": "git status" }, "tool_use_id": "toolu_01" });
        let bare = json!({ "session_id": "s", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": { "command": "git status" } });
        let mixed = json!({ "turn_id": "t1", "prompt_id": "p" });
        assert_eq!(payload_host(&codex), Some("codex"));
        assert_eq!(payload_host(&claude), Some("claude-code"));
        assert_eq!(payload_host(&bare), Some("claude-code"));
        assert_eq!(
            payload_host(&json!({ "model": "Claude-opus-5" })),
            Some("claude-code")
        );
        assert_eq!(payload_host(&json!({ "turn_id": "" })), Some("claude-code"));
        assert_eq!(
            payload_host(
                &json!({ "turn_id": "t1", "model": "claude-opus-5", "tool_use_id": "toolu_1" })
            ),
            Some("codex")
        );
        assert_eq!(
            payload_host(&json!({ "turn_id": "t1", "effort": [] })),
            Some("codex")
        );
        assert_eq!(
            payload_host(&json!({ "turn_id": "t1", "effort": { "level": "high" } })),
            None
        );
        assert_eq!(payload_host(&mixed), None);
    }

    #[test]
    fn codex_payloads_skip_claude_post_processing() {
        let mut payload = json!({ "tool_name": "Bash", "tool_input": { "command": "git log" }, "tool_response": "x" });
        assert!(post_needs_processing(&payload));
        payload["turn_id"] = json!("t1");
        assert!(!post_needs_processing(&payload));
    }

    #[test]
    fn ambiguous_pre_tool_payloads_stay_silent() {
        assert_eq!(pre_tool(br#"{"turn_id":"t1","prompt_id":"p","tool_name":"Bash","tool_input":{"command":"git status"}}"#.to_vec()), 0);
    }

    #[test]
    fn hook_exit_codes_never_block() {
        assert_eq!(non_blocking(2), 1);
        assert_eq!(non_blocking(0), 0);
        assert_eq!(non_blocking(1), 1);
        assert_eq!(non_blocking(143), 143);
    }

    #[test]
    fn descriptor_authenticity_requires_protocol_version_and_hex_token() {
        let descriptor = |protocol: u32, version: &str, token: String| Descriptor {
            protocol,
            version: version.to_owned(),
            home: PathBuf::from("h"),
            path: PathBuf::from("p"),
            token,
        };
        let version = env!("CARGO_PKG_VERSION");
        assert!(descriptor(2, version, "a".repeat(64)).authentic());
        assert!(!descriptor(1, version, "a".repeat(64)).authentic());
        assert!(!descriptor(2, "0.0.0", "a".repeat(64)).authentic());
        assert!(!descriptor(2, version, "A".repeat(64)).authentic());
        assert!(!descriptor(2, version, "a".repeat(63)).authentic());
    }
}
