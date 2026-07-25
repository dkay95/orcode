import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findSshHost, loadSshHosts } from "../src/ssh-config.js";

async function tempSshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "routercode-sshconfig-test-"));
}

test("loadSshHosts: parses HostName, User, Port, IdentityFile, ProxyJump", async () => {
  const dir = await tempSshDir();
  try {
    const configPath = join(dir, "config");
    await writeFile(
      configPath,
      [
        "Host vps",
        "  HostName 203.0.113.5",
        "  User deploy",
        "  Port 2222",
        "  IdentityFile ~/.ssh/id_vps",
        "  ProxyJump bastion",
        "",
      ].join("\n"),
    );
    const hosts = await loadSshHosts({ configPath, homeDir: dir });
    assert.equal(hosts.length, 1);
    const vps = findSshHost("vps", hosts);
    assert.ok(vps);
    assert.equal(vps?.hostName, "203.0.113.5");
    assert.equal(vps?.user, "deploy");
    assert.equal(vps?.port, 2222);
    assert.deepEqual(vps?.identityFile, ["~/.ssh/id_vps"]);
    assert.equal(vps?.proxyJump, "bastion");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSshHosts: HostName defaults to the alias when unset", async () => {
  const dir = await tempSshDir();
  try {
    const configPath = join(dir, "config");
    await writeFile(configPath, "Host plain\n  User root\n");
    const hosts = await loadSshHosts({ configPath, homeDir: dir });
    assert.equal(hosts[0]?.hostName, "plain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSshHosts: multiple aliases on one Host line each become a target", async () => {
  const dir = await tempSshDir();
  try {
    const configPath = join(dir, "config");
    await writeFile(configPath, "Host web1 web2\n  HostName cluster.example.com\n  User ops\n");
    const hosts = await loadSshHosts({ configPath, homeDir: dir });
    assert.deepEqual(
      hosts.map((h) => h.alias).sort(),
      ["web1", "web2"],
    );
    assert.equal(findSshHost("web1", hosts)?.hostName, "cluster.example.com");
    assert.equal(findSshHost("web2", hosts)?.user, "ops");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSshHosts: Host * is a wildcard default, never a selectable target, but still cascades", async () => {
  const dir = await tempSshDir();
  try {
    const configPath = join(dir, "config");
    await writeFile(
      configPath,
      [
        "Host vps",
        "  HostName 203.0.113.5",
        "",
        "Host *",
        "  User globaluser",
        "  Port 2200",
        "",
      ].join("\n"),
    );
    const hosts = await loadSshHosts({ configPath, homeDir: dir });
    assert.deepEqual(hosts.map((h) => h.alias), ["vps"]);
    const vps = findSshHost("vps", hosts)!;
    // Not set in the specific block: falls through to the wildcard default.
    assert.equal(vps.user, "globaluser");
    assert.equal(vps.port, 2200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSshHosts: first obtained value wins — a specific block beats a later wildcard default", async () => {
  const dir = await tempSshDir();
  try {
    const configPath = join(dir, "config");
    await writeFile(
      configPath,
      [
        "Host vps",
        "  HostName 203.0.113.5",
        "  Port 22",
        "",
        "Host *",
        "  Port 2200",
        "",
      ].join("\n"),
    );
    const hosts = await loadSshHosts({ configPath, homeDir: dir });
    assert.equal(findSshHost("vps", hosts)?.port, 22);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSshHosts: wildcard patterns with glob characters never become targets", async () => {
  const dir = await tempSshDir();
  try {
    const configPath = join(dir, "config");
    await writeFile(
      configPath,
      ["Host *.internal", "  User svc", "", "Host db?", "  User dba", ""].join("\n"),
    );
    const hosts = await loadSshHosts({ configPath, homeDir: dir });
    assert.deepEqual(hosts, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSshHosts: Include pulls in a nested file recursively", async () => {
  const dir = await tempSshDir();
  try {
    const sshDir = join(dir, ".ssh");
    await mkdir(join(sshDir, "conf.d"), { recursive: true });
    const configPath = join(sshDir, "config");
    await writeFile(configPath, ["Include conf.d/extra.conf", "", "Host main", "  HostName 10.0.0.1", ""].join("\n"));
    await writeFile(
      join(sshDir, "conf.d", "extra.conf"),
      ["Host extra", "  HostName 10.0.0.2", "  User extrauser", ""].join("\n"),
    );
    const hosts = await loadSshHosts({ configPath, homeDir: dir });
    assert.deepEqual(
      hosts.map((h) => h.alias).sort(),
      ["extra", "main"],
    );
    assert.equal(findSshHost("extra", hosts)?.hostName, "10.0.0.2");
    assert.equal(findSshHost("main", hosts)?.hostName, "10.0.0.1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSshHosts: an Include cycle terminates instead of hanging or throwing", async () => {
  const dir = await tempSshDir();
  try {
    const sshDir = join(dir, ".ssh");
    await mkdir(sshDir, { recursive: true });
    const a = join(sshDir, "a.conf");
    const b = join(sshDir, "b.conf");
    await writeFile(a, ["Include b.conf", "Host from-a", "  HostName 10.0.0.10", ""].join("\n"));
    await writeFile(b, ["Include a.conf", "Host from-b", "  HostName 10.0.0.11", ""].join("\n"));
    const hosts = await loadSshHosts({ configPath: a, homeDir: dir });
    assert.deepEqual(
      hosts.map((h) => h.alias).sort(),
      ["from-a", "from-b"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSshHosts: a runaway Include depth is bounded, not infinite", async () => {
  const dir = await tempSshDir();
  try {
    const sshDir = join(dir, ".ssh");
    await mkdir(sshDir, { recursive: true });
    const depth = 40;
    for (let index = 0; index < depth; index += 1) {
      await writeFile(
        join(sshDir, `chain${index}.conf`),
        [`Include chain${index + 1}.conf`, `Host level${index}`, `  HostName 10.0.1.${index}`, ""].join("\n"),
      );
    }
    await writeFile(join(sshDir, `chain${depth}.conf`), `Host level${depth}\n  HostName 10.0.1.${depth}\n`);
    const hosts = await loadSshHosts({
      configPath: join(sshDir, "chain0.conf"),
      homeDir: dir,
      maxIncludeDepth: 5,
    });
    // Only the levels within the depth budget were ever read.
    assert.ok(hosts.length <= 6, `erwartet höchstens 6 Hosts, bekommen ${hosts.length}`);
    assert.ok(hosts.length >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSshHosts: a missing config file is not an error", async () => {
  const dir = await tempSshDir();
  try {
    const hosts = await loadSshHosts({ configPath: join(dir, "does-not-exist"), homeDir: dir });
    assert.deepEqual(hosts, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSshHosts: a missing Include target is not an error", async () => {
  const dir = await tempSshDir();
  try {
    const configPath = join(dir, "config");
    await writeFile(configPath, "Include missing.conf\nHost solo\n  HostName 10.0.0.5\n");
    const hosts = await loadSshHosts({ configPath, homeDir: dir });
    assert.deepEqual(hosts.map((h) => h.alias), ["solo"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadSshHosts: ignores comments and blank lines", async () => {
  const dir = await tempSshDir();
  try {
    const configPath = join(dir, "config");
    await writeFile(
      configPath,
      ["# top comment", "", "Host vps # inline comment", "  HostName 203.0.113.5 # trailing", ""].join("\n"),
    );
    const hosts = await loadSshHosts({ configPath, homeDir: dir });
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0]?.alias, "vps");
    assert.equal(hosts[0]?.hostName, "203.0.113.5");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
