import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Keep the image's accounts while making the launching user's numeric identity
// resolvable to SSH, getpwuid(), and tools that look up their home through NSS.
// The process stays unprivileged; these files live only in the container tmpfs.
const directory = mkdtempSync('/run/code-factory/identity-');
try {
  const uid = process.getuid!();
  const gid = process.getgid!();
  const username = process.env.CODE_FACTORY_DOCKER_USERNAME;
  const groupname = process.env.CODE_FACTORY_DOCKER_GROUPNAME || username;
  const home = process.env.HOME;
  const [command, ...args] = process.argv.slice(2);
  if (!command || !username || !groupname || !home || [username, groupname, home].some((value) => /[:\r\n\0]/.test(value))) {
    throw new Error('Invalid Docker agent identity');
  }
  const library = '/usr/local/lib/libnss_wrapper.so';
  if (!existsSync(library)) throw new Error('Docker agent image needs libnss-wrapper; rebuild the bundled runtime image');
  const passwd = readFileSync('/etc/passwd', 'utf8').split('\n').filter((line) => {
    const fields = line.split(':');
    return line && fields[0] !== username && fields[2] !== String(uid);
  });
  passwd.push(`${username}:x:${uid}:${gid}::${home}:/bin/bash`);
  const group = readFileSync('/etc/group', 'utf8').split('\n').filter((line) => {
    const fields = line.split(':');
    return line && fields[0] !== groupname && fields[2] !== String(gid);
  });
  group.push(`${groupname}:x:${gid}:${username}`);
  for (const id of process.getgroups!()) {
    if (!group.some((line) => line.split(':')[2] === String(id))) group.push(`code-factory-${id}:x:${id}:${username}`);
  }
  const passwdPath = join(directory, 'passwd');
  const groupPath = join(directory, 'group');
  writeFileSync(passwdPath, `${passwd.join('\n')}\n`, { mode: 0o600 });
  writeFileSync(groupPath, `${group.join('\n')}\n`, { mode: 0o600 });
  const child = spawn(command, args, { stdio: 'inherit', env: { ...process.env,
    NSS_WRAPPER_PASSWD: passwdPath, NSS_WRAPPER_GROUP: groupPath,
    LD_PRELOAD: [library, process.env.LD_PRELOAD].filter(Boolean).join(' '),
  } });
  process.on('SIGTERM', () => { child.kill('SIGTERM'); });
  process.on('SIGINT', () => { child.kill('SIGINT'); });
  child.once('error', () => {
    console.error('Could not launch the Docker agent command');
    process.exitCode = 1;
    rmSync(directory, { recursive: true, force: true });
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 128 + osConstants.signals[signal] : 1);
    rmSync(directory, { recursive: true, force: true });
  });
} catch (error) {
  rmSync(directory, { recursive: true, force: true });
  throw error;
}
